// Cut a demo from honest-protocol runs: chosen scenario clips, real stage frames, faces, captions, verdicts, cards.
// One job: the demo's timeline and audio. render-honest-demo.mjs turns it into video.
//
// Everything shown is from the runs: the audio is each meeting's own tape (silences longer than 1.5 s are shortened
// to 0.8 s and marked on screen), the shared screen is the real src/meet-stage.js render of the recorded screen state
// (stage-eyes.mjs), and each verdict is the run's own grade.
//
// Usage: node tools/sim-participant/build-honest-demo.mjs <plan.json> <outDir>
//   plan.json: { cards: {...}, clips: [{ run, meeting, id, label? }], scorecards: [...] }
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createStageEyes } from './stage-eyes.mjs';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const RATE = 24000, TICK = 0.1, PER = RATE * 2 * TICK;
const [planPath, outArg] = process.argv.slice(2);
const plan = JSON.parse(await readFile(planPath, 'utf8'));
const outDir = resolve(outArg);
await mkdir(join(outDir, 'frames'), { recursive: true });
const deck = JSON.parse(await readFile(join(ROOT, 'public/slides/projectile-motion-deck/deck.json'), 'utf8'));
const protocol = JSON.parse(await readFile(join(ROOT, 'tools/sim-participant/protocol/protocol.json'), 'utf8'));
const byId = new Map(protocol.scenarios.map(s => [s.id, s]));

const decode = (file, from, to) => new Promise((res, rej) => {
  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-ss', String(from), '-to', String(to), '-i', file, '-f', 's16le', '-ac', '1', '-ar', String(RATE), '-']);
  const parts = []; ff.stdout.on('data', d => parts.push(d)); ff.on('error', rej);
  ff.on('close', code => code === 0 ? res(Buffer.concat(parts)) : rej(new Error(`decode ${file} ${code}`)));
});
const loud = (pcm, i) => { let s = 0, n = 0; for (let k = i * PER; k < Math.min(pcm.length, (i + 1) * PER) - 1; k += 2) { const v = pcm.readInt16LE(k); s += v * v; n++; } return n && Math.sqrt(s / n) > 300; };

// Whisper transcription of one voice (s16le mono 24 kHz) with segment timestamps.
async function whisper(pcm) {
  if (!pcm.length) return [];
  const head = Buffer.alloc(44); head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVE', 8); head.write('fmt ', 12);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(RATE, 24); head.writeUInt32LE(RATE * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
  const form = new FormData();
  form.append('file', new Blob([Buffer.concat([head, pcm])], { type: 'audio/wav' }), 'clip.wav');
  form.append('model', 'whisper-1'); form.append('response_format', 'verbose_json'); form.append('timestamp_granularities[]', 'segment'); form.append('language', 'en');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form });
  if (!res.ok) throw new Error(`whisper HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).segments || [];
}
const eyes = await createStageEyes({ publicDir: join(ROOT, 'public') });
const shots = new Map();
async function shot(screen) {
  const key = createHash('sha1').update(JSON.stringify([screen.deck, screen.view, screen.box])).digest('hex').slice(0, 12);
  if (shots.has(key)) return shots.get(key);
  const slides = [{ asset: deck.slides[0].asset, views: deck.slides[0].views.map((v, i) => ({ ...v, highlight: i === screen.view ? screen.box : null })) }];
  const png = await eyes.frame({ slides, slideIndex: 0, viewIndex: screen.view, title: deck.title });
  const src = `frames/${key}.png`; await writeFile(join(outDir, src), png); shots.set(key, src); return src;
}

const segments = [], robotOut = [], alexOut = [], frames = [];
const firstSentence = text => { const m = String(text).match(/^.*?[.!?](?=\s|$)/); const s = (m ? m[0] : String(text)).trim(); return s.length > 170 ? `${s.slice(0, s.lastIndexOf(' ', 165))}…` : s; };
const clipWhy = text => { const s = String(text || ''); return s.length > 190 ? `${s.slice(0, s.lastIndexOf(' ', 185))}…` : s; };
let t = 0;
const pushSilence = sec => { const b = Buffer.alloc(Math.round(sec * RATE) * 2); robotOut.push(b); alexOut.push(b); };
for (const item of plan.sequence) {
  if (item.card) {
    const sec = item.sec || 5;
    for (const [dest, src] of Object.entries(item.images || {})) await copyFile(resolve(ROOT, src), join(outDir, dest));
    segments.push({ kind: 'card', start: t, end: t + sec, html: item.card });
    pushSilence(sec); t += sec; continue;
  }
  const runDir = resolve(ROOT, item.run), ch = join(runDir, `ch${item.meeting}`);
  const tl = JSON.parse(await readFile(join(ch, 'timeline.json'), 'utf8'));
  const r = tl.results.find(x => x.id === item.id);
  if (!r || r.skipped) { console.log(`skip ${item.id}: ${r?.skipped || 'not found'}`); continue; }
  const from = Math.max(0, r.tapeStart - 0.3 + (item.startOffset || 0)), to = r.tapeEnd + 0.8; // startOffset skips a late answer to the previous scenario
  const [rp, ap] = await Promise.all([decode(join(ch, 'robot.opus'), from, to), decode(join(ch, 'alex.opus'), from, to)]);
  const n = Math.floor(Math.min(rp.length, ap.length) / PER);
  // Keep every tick anyone is on air; shorten quiet stretches over 1.5 s to 0.8 s and mark them.
  const keep = [], map = new Array(n), badges = []; let quiet = 0, runStart = 0;
  for (let i = 0; i < n; i++) {
    const on = loud(rp, i) || loud(ap, i);
    if (on) { if (quiet * TICK > 1.5) badges.push({ at: t + keep.length * TICK - 0.8, text: `⏩ ${(quiet * TICK).toFixed(0)} s of quiet shortened` }); quiet = 0; }
    else quiet++;
    if (on || quiet * TICK <= 0.8) keep.push(i);
    map[i] = Math.max(0, keep.length - 1);
  }
  // A clip longer than maxSec (after shortening quiet) is cut there, and the cut is marked on screen.
  if (item.maxSec && keep.length * TICK > item.maxSec) { keep.length = Math.round(item.maxSec / TICK); badges.push({ at: t + item.maxSec - 2.2, text: '✂ clip cut here for length' }); }
  const at = sec => t + Math.min(keep.length, (map[Math.min(n - 1, Math.max(0, Math.round((sec - from) / TICK)))] ?? 0)) * TICK;
  const pick = pcm => Buffer.concat(keep.map(i => pcm.subarray(i * PER, (i + 1) * PER)));
  const rk = pick(rp), ak = pick(ap);
  robotOut.push(rk); alexOut.push(ak);
  const dur = keep.length * TICK;
  // screen states within the clip, on the demo clock
  const tickSec = tl.tickMs / 1000;
  const inClip = tl.screen.filter(s => s.tick * tickSec >= from && s.tick * tickSec <= to);
  const before = tl.screen.filter(s => s.tick * tickSec < from).at(-1) || tl.screen[0];
  const screens = [];
  for (const s of [before, ...inClip]) if (s) screens.push({ at: s === before ? t : at(s.tick * tickSec), src: s.deck === 'other' ? await shot({ view: 0, box: null, deck: 'pdf' }) : await shot(s) });
  // Captions: WHEN from the audio, WHAT from the record. Whisper, run on each voice of the clip (after quiet was
  // shortened), says where each stretch of speech is and roughly what it says; each segment is then snapped to the
  // ticks where that voice is actually loud, and its words are replaced by the matching words of GPT Live's own
  // transcript of that voice (the timeline's captions near the clip). Two audits caught the alternatives: recorded
  // text placed by heuristics put answers before questions, and Whisper alone once turned "over g" into "over 2g".
  const NUM = { 0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten' };
  const norm = w => String(w).toLowerCase().normalize('NFKC').replace(/[‘’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean).flatMap(x => { const m = x.match(/^(\d+)([a-z]+)$/); return m ? [m[1], m[2]] : [x]; }).map(x => NUM[x] || x.replace(/^naught$|^not$/, 'naught'));
  const loudTicks = (pcm, a, b) => { const on = []; for (let k = Math.max(0, a); k < Math.min(b, keep.length); k++) if (loud(pcm, k)) on.push(k); return on; };
  const words = text => String(text || '').replace(/\s*\|\|\s*/g, ' ').split(/\s+/).filter(Boolean);
  // First this scenario's own recorded exchange (what that voice said in the scenario's window), then the meeting's
  // captions near the clip, which need a stronger match (they can hold similar words from another moment).
  const corpusOf = who => words(who === 'Alex' ? r.asked : r.answer);
  const nearbyOf = who => tl.captions.filter(c => c.who === who && c.sec >= from - 60 && c.sec <= to + 60).flatMap(c => words(c.text));
  const fromRecord = (segText, corpus, min = 0.5, cursor = { at: 0 }) => {
    const want = norm(segText); if (want.length < 3 || !corpus.length) return null;
    const cn = corpus.map(w => norm(w).join(' ')); const wantSet = new Set(want);
    let best = null;
    for (let L = Math.max(2, want.length - 3); L <= want.length + 3; L++) for (let i = Math.max(0, cursor.at - 2); i + L <= corpus.length; i++) { // forward only: speech is in order
      const win = cn.slice(i, i + L).join(' ').split(' ').filter(Boolean); let hit = 0; for (const w of new Set(win)) if (wantSet.has(w)) hit++;
      const score = hit / Math.max(wantSet.size, new Set(win).size);
      if (!best || score > best.score) best = { score, i, L };
    }
    if (!best || best.score < min) return null;
    // Keep only what this segment says, in order: align the segment's words to the region around the best window by
    // longest common subsequence, and span from the first to the last aligned word. A shared word out of order (the
    // "the" of a later sentence) can then not pull that sentence in.
    const i0 = Math.max(0, best.i - 6), i1 = Math.min(corpus.length, best.i + best.L + 6);
    const toks = []; for (let w = i0; w < i1; w++) for (const x of norm(corpus[w])) toks.push({ x, w });
    const m = want.length, n2 = toks.length, dp = Array.from({ length: m + 1 }, () => new Array(n2 + 1).fill(0));
    for (let a = m - 1; a >= 0; a--) for (let b = n2 - 1; b >= 0; b--) dp[a][b] = want[a] === toks[b].x ? dp[a + 1][b + 1] + 1 : Math.max(dp[a + 1][b], dp[a][b + 1]);
    const hitW = []; for (let a = 0, b = 0; a < m && b < n2;) { if (want[a] === toks[b].x) { hitW.push(toks[b].w); a++; b++; } else if (dp[a + 1][b] >= dp[a][b + 1]) a++; else b++; }
    if (hitW.length < Math.max(2, Math.ceil(want.length * 0.5))) return null;
    cursor.at = hitW.at(-1) + 1;
    return corpus.slice(hitW[0], hitW.at(-1) + 1).join(' ');
  };
  const toCaptions = async (who, pcm) => {
    const corpus = corpusOf(who), out = [], cursor = { at: 0 }, nearCursor = { at: 0 };
    for (const g of await whisper(pcm)) {
      if ((g.no_speech_prob ?? 0) >= 0.6) continue;
      const on = loudTicks(pcm, Math.floor(g.start / TICK) - 5, Math.ceil(g.end / TICK) + 5);
      if (on.length < 4) continue; // Whisper hears speech in near-silence sometimes; keep only what is audible
      const own = fromRecord(g.text, corpus, 0.5, cursor), near = own ? null : fromRecord(g.text, nearbyOf(who), 0.75, nearCursor);
      out.push({ who, text: own || near || String(g.text).trim(), sec: t + on[0] * TICK, end: t + (on.at(-1) + 1) * TICK, from: own ? 'record' : near ? 'nearby' : 'whisper' });
    }
    return out;
  };
  const pickedR = Buffer.concat(keep.map(i => rp.subarray(i * PER, (i + 1) * PER))), pickedA = Buffer.concat(keep.map(i => ap.subarray(i * PER, (i + 1) * PER)));
  // Adjacent segments of one voice can share words once snapped to sentences: a caption wholly inside the previous one
  // is merged into it, and a repeated opening is trimmed.
  const dedupe = list => { const out = [];
    for (const c of list) { const prev = out.at(-1), a = prev ? words(prev.text) : [], b = words(c.text);
      if (prev && b.join(' ') && a.join(' ').includes(b.join(' '))) { prev.end = Math.max(prev.end, c.end); continue; }
      let k = 0; for (let n = Math.min(a.length, b.length); n >= 2; n--) if (a.slice(-n).join(' ') === b.slice(0, n).join(' ')) { k = n; break; }
      out.push(k ? { ...c, text: b.slice(k).join(' ') } : c); }
    return out.filter(c => c.text.trim()); };
  let captions = [...dedupe(await toCaptions('Vivek Bot', pickedR)), ...dedupe(await toCaptions('Alex', pickedA))];
  captions = captions.sort((a, b) => a.sec - b.sec);
  const sc = byId.get(item.id);
  const didNote = r.checks?.length ? r.checks[0] : (r.tools?.length ? `ran ${[...new Set(r.tools)].join(', ')}` : 'no tool needed');
  const feelNote = r.feelNotes?.length ? r.feelNotes[0] : (r.latency != null ? `${r.latency.toFixed(1)} s to first word` : '');
  segments.push({ kind: 'clip', start: t, end: t + dur, where: item.where || tl.chapter.replace(/^Meeting (\d+):\s*([^.(]*).*/, 'Meeting $1 · $2'),
    kicker: item.kicker || sc?.idealItem?.split(/[:(]/)[0] || '', title: sc?.title || item.id, need: item.need || firstSentence(sc?.whyItMatters || ''),
    verdict: { did: r.did, conveyed: r.conveyed, clean: r.clean, felt: r.felt, didNote, feelNote, why: r.pass ? '' : clipWhy([...(r.checks || []), r.why, ...(r.feelNotes || [])].filter(x => x && x !== 'ok')[0] || '') },
    revealAt: t + Math.max(0, dur - (item.revealSec || 4)), stamp: item.stamp?.cls || (r.pass ? 'pass' : 'fail'), stampText: item.stamp?.text || (r.pass ? 'PASS' : 'FAIL'), // a plan can state an essential-only acceptance
    screens, captions, badges });
  console.log(`${item.id}: ${dur.toFixed(1)} s (from ${(to - from).toFixed(1)} s)`);
  t += dur;
}
await eyes.close();
// per-frame face bands at 25 fps, the same measurement src/face.js makes (1024 samples before t, 900 Hz split)
const FPS = plan.fps || 25;
const robotPcm = Buffer.concat(robotOut), alexPcm = Buffer.concat(alexOut);
const bands = (pcm, sec) => {
  const end = Math.min(pcm.length / 2, Math.floor(sec * RATE)), start = Math.max(0, end - 1024), a = Math.exp(-2 * Math.PI * 900 / RATE);
  let sum = 0, lp = 0, lo = 0, hi = 0;
  for (let i = start; i < end; i++) { const x = pcm.readInt16LE(i * 2) / 32768; sum += x * x; lp = a * lp + (1 - a) * x; lo += lp * lp; const h = x - lp; hi += h * h; }
  const rms = Math.sqrt(sum / Math.max(1, end - start)), sl = Math.sqrt(lo), sh = Math.sqrt(hi);
  return [Math.max(0, Math.min(1, (rms - 0.008) * 9)), sl + sh > 0 ? sl / (sl + sh) : 0.5].map(v => Math.round(v * 1000) / 1000);
};
for (let i = 0; i < Math.ceil(t * FPS); i++) frames.push({ r: bands(robotPcm, i / FPS), a: bands(alexPcm, i / FPS) });
await writeFile(join(outDir, 'robot.pcm'), robotPcm); await writeFile(join(outDir, 'alex.pcm'), alexPcm);
await writeFile(join(outDir, 'demo.json'), JSON.stringify({ duration: t, fps: FPS, segments, frames }));
console.log(`demo: ${t.toFixed(1)} s, ${segments.length} segments, ${shots.size} stage frames`);
process.exit(0);
