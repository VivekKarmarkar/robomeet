// Does the robot actually USE the scroll tool, and does the screen really move?
//
// A tool existing is not the same as a model reaching for it. This gives the backend model the REAL tool list from
// src/live.mjs, asks for a scroll the way a person would, executes whatever tool it picks against the REAL server,
// and then checks the screen against what it said. Picking ask_coding_agent for a plain scroll is a failure: that is
// the several-second path the tool exists to replace.
import { mkdtemp, mkdir, copyFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server.mjs';
import { sessionConfig } from '../../src/live.mjs';
import { startScreenFeed } from '../../src/screen-feed.mjs';
import { wordsForDeck } from '../../src/word-boxes.mjs';

const KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.ROBO_BACKEND_MODEL || 'gpt-5.6-sol';
const DECK = new URL('../../public/slides/projectile-motion-deck/', import.meta.url);
const wait = ms => new Promise(r => setTimeout(r, ms));
// The real tools the backend is given, straight out of the session config. Not a copy.
const TOOLS = sessionConfig('').delegation.responses.tools;

async function turn(input) {
  const res = await fetch('https://api.openai.com/v1/responses', { method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input, tools: TOOLS, tool_choice: 'auto', parallel_tool_calls: false, max_output_tokens: 400 }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const out = body.output || [];
  const call = out.find(o => o.type === 'function_call');
  const text = out.flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join(' ').trim();
  return { call, text, raw: out };
}

const SYSTEM = 'You are Vivek Bot, an AI participant in a Google Meet, sharing your screen. You cannot see the screen; RoboMeet sends you SCREEN: lines whenever it changes. Use your tools. Answer in one short spoken sentence.';

export async function runScrollLoop({ out = 'scroll-report.json' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'robomeet-sl-'));
  const publicDir = join(dir, 'public');
  await mkdir(join(publicDir, 'slides', 'pm'), { recursive: true });
  for (const n of ['deck.json', 'page-1.png', 'page-1-view-1.png', 'page-1-view-2.png', 'page-1-view-3.png']) await copyFile(new URL(n, DECK), join(publicDir, 'slides', 'pm', n));
  const frames = [];
  let wired = null;
  const app = await createApp({ port: 0, dataDir: join(dir, 'data'), publicDir,
    workerFactory: () => ({ leave: async () => {}, join: async () => {}, present: async () => {}, syncStage: async () => {} }),
    liveFactory: o => { wired = o; return { sessions: new Map(), closeAll: async () => {}, setMode() {}, activeSession: () => ({ id: 's' }),
      context: t => { if (/^SCREEN:/.test(t)) frames.push(t); return true; }, instruct: async () => true, onTranscript: () => () => {} }; } });
  const feed = startScreenFeed({ store: app.store, live: app.live, fps: 10, wordsFor: s => wordsForDeck(publicDir, s).catch(() => null) });
  await app.command({ type: 'present-deck', slug: 'pm' });
  app.store.update({ meeting: { ...app.store.state.meeting, sharing: true } }, 'loop.sharing', {});
  await wait(400);

  const asks = [
    { id: 'SC1', say: 'Scroll down a bit for me.', want: 'scroll', expect: s => s.view === 1 },
    { id: 'SC2', say: 'Keep going, next part.', want: 'scroll', expect: s => s.view === 2 },
    { id: 'SC3', say: 'Go back up one.', want: 'scroll', expect: s => s.view === 1 },
    { id: 'SC4', say: 'Take me to the very top of the document.', want: 'scroll', expect: s => s.view === 0 },
    { id: 'SC5', say: 'Jump to part three please.', want: 'scroll', expect: s => s.view === 2 },
    { id: 'SC6', say: 'Can you scroll down again?', want: null, expect: s => s.view === 2, note: 'already at the end: it must say so, not move' },
    { id: 'SC7', say: 'Have a look in the repo and tell me how many test files there are.', want: 'ask_coding_agent', expect: s => s.view === 2, note: 'real work still goes to the coding agent' },
  ];

  const transcript = [{ type: 'message', role: 'system', content: [{ type: 'input_text', text: SYSTEM }] }];
  const results = []; let sent = 0;
  for (const step of asks) {
    for (const f of frames.slice(sent)) transcript.push({ type: 'message', role: 'system', content: [{ type: 'input_text', text: f }] });
    sent = frames.length;
    transcript.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: step.say }] });
    const { call, text, raw } = await turn(transcript);
    let outcome = text, ok = true, picked = call?.name ?? null, error = null;
    for (const o of raw) transcript.push(o);
    if (call) {
      const args = JSON.parse(call.arguments || '{}');
      try {
        const result = call.name === 'scroll' ? await wired.scrollTo(args.to)
          : call.name === 'point_at' ? await wired.pointAt({ phrase: args.target })
          : { accepted: true, note: 'routed to the coding agent' };
        outcome = JSON.stringify(result);
      } catch (e) { error = e.message; outcome = `refused: ${e.message}`; }
      transcript.push({ type: 'function_call_output', call_id: call.call_id, output: outcome.slice(0, 600) });
      const after = await turn(transcript);
      if (after.text) { transcript.push(...after.raw); outcome = `${outcome}  ||  said: ${after.text}`; }
    }
    await wait(400);
    const state = { slide: Number(app.store.state.slideIndex) || 0, view: Number(app.store.state.viewIndex) || 0 };
    const toolOk = step.want === null ? picked === null || picked === 'scroll' : picked === step.want;
    ok = toolOk && step.expect(state);
    results.push({ id: step.id, say: step.say, picked, want: step.want, state, ok, outcome: outcome.slice(0, 200), error });
    console.log(`${step.id} ${ok ? 'PASS' : 'FAIL'}  "${step.say}"`);
    console.log(`      tool: ${picked ?? '(none)'}${step.want ? ` (wanted ${step.want})` : ''}   screen now: page ${state.slide + 1} part ${state.view + 1}`);
    console.log(`      ${outcome.replace(/\s+/g, ' ').slice(0, 130)}`);
  }
  feed.stop(); await app.close(); await rm(dir, { recursive: true, force: true });
  const pass = results.filter(r => r.ok).length;
  console.log(`\nscroll tool: ${pass}/${results.length} pass`);
  await writeFile(out, JSON.stringify({ model: MODEL, results }, null, 2));
  return { pass, total: results.length, results };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = n => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null; };
  await runScrollLoop({ out: arg('out') || 'scroll-report.json' });
}
