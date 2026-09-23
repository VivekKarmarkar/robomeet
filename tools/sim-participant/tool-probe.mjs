// Does a briefing change stop the robot from using its tools? One job: count tool calls for plain requests.
// One real robot session per briefing source; Alex (scripted, muted) makes simple requests; every function call and
// every session error is recorded. Usage: node tools/sim-participant/tool-probe.mjs <attend-snapshot.mjs>...
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server.mjs';
import { sessionConfig } from '../../src/live.mjs';
import { openLiveSession } from './live-session.mjs';
import { startPacer, RATE } from './pacer.mjs';
import { realBriefing } from './briefing.mjs';
import { startRoomSignals } from './room-signals.mjs';
import { startScreenFeed } from '../../src/screen-feed.mjs';
import { wordsForDeck } from '../../src/word-boxes.mjs';
import { watchScreen } from '../../src/screen-context.mjs';
// --screen=permove|none|map|held: how the part's content reaches the robot (the server's own watcher is muted here)
const SCREEN = (process.argv.find(a => a.startsWith('--screen=')) || '--screen=server').split('=')[1];
const SIGNALS = process.argv.includes('--signals'); // the page's speech events: the held screen text goes out when Alex speaks

const SLUG = 'projectile-motion-deck', DECK = new URL(`../../public/slides/${SLUG}/`, import.meta.url);
const wait = ms => new Promise(r => setTimeout(r, ms));
process.env.ROBO_BACKEND_MODEL ||= 'gpt-5.6-sol';
const REQUESTS = ['Next part, please.', 'Box equation seven.', 'Go to the top.', 'Box equation three.', 'Go to the end.', 'What does equation eight say, exactly?'];

async function trial(src) {
  process.env.HONEST_ATTEND_SRC = src;
  const dir = await mkdtemp(join(tmpdir(), 'robomeet-tools-')), publicDir = join(dir, 'public');
  await mkdir(join(publicDir, 'slides', SLUG), { recursive: true });
  for (const n of ['deck.json', 'page-1.png', 'page-1-view-1.png', 'page-1-view-2.png', 'page-1-view-3.png']) await copyFile(new URL(n, DECK), join(publicDir, 'slides', SLUG, n));
  let robot = null, wired = null;
  const app = await createApp({ port: 0, dataDir: join(dir, 'data'), publicDir, workerFactory: () => ({ leave: async () => {}, join: async () => {}, present: async () => {}, syncStage: async () => {} }),
    liveFactory: o => { wired = o; return { sessions: new Map(), closeAll: async () => {}, setMode() {}, activeSession: () => (robot ? { id: robot.id } : null), onTranscript: () => () => {}, instruct: async t => { robot?.instruct(t); return true; }, context: t => { if (SCREEN !== 'server' && /^(What your shared deck|On your shared screen now)/.test(t)) return true; robot?.think(t); return true; } }; } });
  await app.command({ type: 'present-deck', slug: SLUG });
  app.store.update({ meeting: { ...app.store.state.meeting, sharing: true } }, 'probe.sharing', {});
  const briefing = await realBriefing({ purpose: 'Alex, a physicist colleague, is meeting you to go through the projectile motion notes you are sharing.' });
  const base = sessionConfig(briefing, briefing);
  robot = await openLiveSession({ name: 'robot', config: { ...base, audio: { format: { type: 'audio/pcm', rate: RATE }, output: base.audio?.output || { voice: 'marin' } } } });
  const calls = [], errs = []; let asked = Date.now();
  robot.on(async e => {
    if (e.type === 'error' || e.event?.type === 'error' || /failed|error/.test(e.event?.type || '')) errs.push(JSON.stringify(e).slice(0, 200));
    if (e.type !== 'response.event' || e.event?.type !== 'response.output_item.done' || e.event.item?.type !== 'function_call') return;
    const item = e.event.item; let args = {}; try { args = JSON.parse(item.arguments || '{}'); } catch {}
    let output; try { output = item.name === 'scroll' ? await wired.scrollTo(String(args.to || '')) : item.name === 'point_at' ? await wired.pointAt({ phrase: String(args.target || '') }) : { ok: true }; } catch (err) { output = { error: err.message }; }
    calls.push(`${item.name}(${JSON.stringify(args)}) +${((Date.now() - asked) / 1000).toFixed(1)}s`);
    robot.send({ type: 'response.item.create', item: { type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(output).slice(0, 500) } }); robot.send({ type: 'response.create' });
  });
  const alex = await openLiveSession({ name: 'alex', config: { model: 'gpt-live-1', instructions: 'You are Alex. You cannot hear the meeting. When you get a stage direction with exact words, say exactly those words and nothing else, then stop.', audio: { format: { type: 'audio/pcm', rate: RATE }, output: { voice: 'cedar' } }, delegation: { type: 'responses', responses: { model: 'gpt-5.6-luna', instructions: 'Never call tools.', tools: [], tool_choice: 'none' } } } });
  alex.send({ type: 'session.input_audio.mute' });
  const pacer = startPacer(robot, alex, {});
  const signals = SIGNALS ? startRoomSignals({ store: app.store, pacer }) : null;
  const probeLive = { activeSession: () => ({ id: robot.id }), context: t => { robot.think(t); return true; } };
  const unwatch = SCREEN === 'permove' ? watchScreen({ store: app.store, live: probeLive }) : SCREEN === 'map' ? watchScreen({ store: app.store, live: probeLive, mapOnce: true }) : SCREEN === 'held' ? watchScreen({ store: app.store, live: probeLive, untilSpeech: true }) : () => {};
  app.store.update({}, 'probe.voice_ready', {}); // the screen watcher sends the deck map once a voice session exists
  const feed = startScreenFeed({ store: app.store, live: { activeSession: () => ({ id: robot.id }), context: t => { robot.think(t); return true; } }, fps: 10, wordsFor: s => wordsForDeck(publicDir, s).catch(() => null) });
  await wait(4000);
  const rows = [];
  for (const line of REQUESTS) {
    const c0 = calls.length, s0 = robot.saidLog.length;
    const t0 = Date.now(); alex.instruct(`Stage direction: say exactly these words, and nothing else: "${line}"`); alex.send({ type: 'session.commentary.append', delegation_id: null, content: 'Begin now, following the instructions provided.' });
    while (Date.now() - t0 < 20000 && !(pacer.state.b.lastOn > t0 && !pacer.speaking('b'))) await wait(50); asked = Date.now();
    await wait(15000);
    rows.push({ line, calls: calls.slice(c0), said: robot.saidLog.slice(s0).map(x => x.text).join('').trim().slice(0, 110) });
  }
  unwatch(); signals?.stop(); feed.stop(); pacer.stop(); await robot.close(); await alex.close(); await app.close(); await rm(dir, { recursive: true, force: true });
  return { rows, errs: [...robot.errors, ...errs].slice(0, 5) };
}
for (const src of process.argv.slice(2).filter(a => !a.startsWith('--'))) {
  const r = await trial(src);
  console.log(`\n[screen=${SCREEN}${SIGNALS ? ', speech signals on' : ''}] ${src.split('/').slice(-2).join('/')}: tool calls for ${r.rows.filter(x => x.calls.length).length}/${r.rows.length} requests; errors: ${r.errs.length ? r.errs.join(' || ') : 'none'}`);
  for (const x of r.rows) console.log(`  ${x.line.padEnd(22)} ${x.calls.join(', ') || 'NO TOOL'}  | ${x.said}`);
}
process.exit(0);
