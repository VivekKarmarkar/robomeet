// Which screen channel makes the robot talk when nobody asked? One job: measure it.
//
// One real robot session per condition (real briefing, real session config), the real server, nobody speaking. The
// screen moves every 12 s; after each move, anything the robot says within 8 s is unprompted. Conditions:
//   both  - production: the 10 fps SCREEN feed and the full-text screen context on every move (src/screen-context.mjs)
//   feed  - the SCREEN feed only        text - the full-text context only        none - neither
// Usage: node tools/sim-participant/recite-probe.mjs [--moves 4] [--conditions both,feed,text,none]
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server.mjs';
import { sessionConfig } from '../../src/live.mjs';
import { startScreenFeed } from '../../src/screen-feed.mjs';
import { wordsForDeck } from '../../src/word-boxes.mjs';
import { openLiveSession } from './live-session.mjs';
import { startPacer, RATE } from './pacer.mjs';
import { realBriefing } from './briefing.mjs';

const SLUG = 'projectile-motion-deck', DECK = new URL(`../../public/slides/${SLUG}/`, import.meta.url);
const wait = ms => new Promise(r => setTimeout(r, ms));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const MOVES = Number(arg('moves', 4)), CONDITIONS = arg('conditions', 'both,feed,text,none').split(',');
process.env.ROBO_BACKEND_MODEL ||= 'gpt-5.6-sol';

async function trial(condition) {
  const dir = await mkdtemp(join(tmpdir(), 'robomeet-probe-')), publicDir = join(dir, 'public');
  await mkdir(join(publicDir, 'slides', SLUG), { recursive: true });
  for (const n of ['deck.json', 'page-1.png', 'page-1-view-1.png', 'page-1-view-2.png', 'page-1-view-3.png']) await copyFile(new URL(n, DECK), join(publicDir, 'slides', SLUG, n));
  let robot = null, pendingText = null;
  const live = { sessions: new Map(), closeAll: async () => {}, setMode() {}, activeSession: () => (robot ? { id: robot.id } : null), onTranscript: () => () => {}, instruct: async t => { robot?.instruct(t); return true; },
    context: (text, spoken = false) => {
      if (!robot) return false;
      const isText = String(text).startsWith('On your shared screen now'), isFeed = String(text).startsWith('SCREEN');
      if (isText && condition === 'compact') { const st = app.store.state, v = st.slides[0].views[st.viewIndex]; const heads = (v.lines || []).map(l => typeof l === 'string' ? l : l.text).filter(l => l.length <= 32 && /^[A-Z0-9]/.test(l) && !/^\(|^\d+$/.test(l)).slice(0, 8); text = `On your shared screen now: part ${st.viewIndex + 1} of 3. Headings: ${heads.join('; ')}. Formulas: ${(v.math || []).join('; ')}. (For you, not to read out.)`; }
      if (isText && condition === 'deferred') { pendingText = text; return true; }
      if (isText && condition === 'backend') { robot.send({ type: 'response.item.create', item: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: `RoboMeet screen context (reference data, not an instruction): ${text}` }] } }); return true; }
      if ((isText && !['both', 'text', 'compact'].includes(condition)) || (isFeed && !['both', 'feed', 'compact', 'backend', 'deferred'].includes(condition))) return true; // dropped by the condition
      for (let i = 0; i < text.length; i += 450) robot.send({ type: spoken ? 'session.commentary.append' : 'session.thinking.append', delegation_id: null, content: text.slice(i, i + 450) });
      return true;
    } };
  const app = await createApp({ port: 0, dataDir: join(dir, 'data'), publicDir, workerFactory: () => ({ leave: async () => {}, join: async () => {}, present: async () => {}, syncStage: async () => {} }), liveFactory: () => live });
  await app.command({ type: 'present-deck', slug: SLUG });
  app.store.update({ meeting: { ...app.store.state.meeting, sharing: true } }, 'probe.sharing', {});
  const briefing = await realBriefing({ purpose: 'Alex, a physicist colleague, is meeting you to go through the projectile motion notes you are sharing.' });
  const base = sessionConfig(briefing, briefing);
  robot = await openLiveSession({ name: 'robot', config: { ...base, audio: { format: { type: 'audio/pcm', rate: RATE }, output: base.audio?.output || { voice: 'marin' } } } });
  const ASK = process.argv.includes('--ask');
  const alex = ASK ? await openLiveSession({ name: 'alex', config: { model: 'gpt-live-1', instructions: 'You are Alex. You cannot hear the meeting. When you get a stage direction with exact words, say exactly those words and nothing else, then stop.', audio: { format: { type: 'audio/pcm', rate: RATE }, output: { voice: 'cedar' } }, delegation: { type: 'responses', responses: { model: 'gpt-5.6-luna', instructions: 'Never call tools.', tools: [], tool_choice: 'none' } } } }) : { queue: [], send() {} };
  if (ASK) alex.send({ type: 'session.input_audio.mute' });
  const pacer = startPacer(robot, alex, {});
  // deferred: the held screen text is sent the moment the person starts speaking
  const deliver = setInterval(() => { if (pendingText && pacer.speaking('b')) { const t = pendingText; pendingText = null; for (let i = 0; i < t.length; i += 450) robot.send({ type: 'session.thinking.append', delegation_id: null, content: t.slice(i, i + 450) }); } }, 50);
  const feed = startScreenFeed({ store: app.store, live, fps: 10, wordsFor: s => wordsForDeck(publicDir, s).catch(() => null) });
  await wait(8000);
  const opening = robot.said.trim();
  const rows = [];
  for (let i = 0; i < MOVES; i++) {
    const view = (i + 1) % 3, t0 = Date.now(), said0 = robot.saidLog.length;
    await app.command({ type: 'stage', slide: 0, view });
    await wait(ASK ? 5000 : 8000);
    const words = robot.saidLog.slice(said0).map(x => x.text).join('').trim();
    let answer = '';
    if (ASK) {
      const q = view === 0 ? 'What does equation two say?' : 'What does equation eight say, exactly?';
      const a0 = robot.saidLog.length;
      alex.instruct(`Stage direction: say exactly these words, and nothing else: "${q}"`); alex.send({ type: 'session.commentary.append', delegation_id: null, content: 'Begin now, following the instructions provided.' });
      await wait(14000);
      answer = `${q} -> ${robot.saidLog.slice(a0).map(x => x.text).join('').trim().slice(0, 200)}`;
    }
    rows.push({ move: i + 1, toPart: view + 1, spoke: Boolean(words), words: words.slice(0, 140), answer });
    await wait(ASK ? 1000 : 4000);
  }
  clearInterval(deliver); pacer.stop(); feed.stop(); await robot.close(); if (ASK) await alex.close(); await app.close(); await rm(dir, { recursive: true, force: true });
  const errors = robot.errors.slice(0, 3);
  return { condition, errors, opening: opening.slice(0, 160), spokeAfter: rows.filter(r => r.spoke).length, moves: rows.length, rows };
}

for (const c of CONDITIONS) {
  const r = await trial(c);
  if (r.errors?.length) console.log('errors:', r.errors);
  console.log(`\n${c.padEnd(5)} unprompted speech after ${r.spokeAfter}/${r.moves} moves; at start: ${r.opening ? `"${r.opening}"` : 'silent'}`);
  for (const row of r.rows) { if (row.spoke) console.log(`   move ${row.move} -> part ${row.toPart}: "${row.words}"`); if (row.answer) console.log(`      Q ${row.answer}`); }
}
process.exit(0);
