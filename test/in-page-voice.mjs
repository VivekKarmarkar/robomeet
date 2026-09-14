// Drives in-page-voice.mjs against the REAL src/server.mjs (unchanged) with a fake GPT Live (same FakeSocket /
// fetchImpl approach as test/server-state.mjs) and a fake Meet page. No browser, no network, no OpenAI.
// Intended destination once adopted: test/in-page-voice.mjs (new file).  Run: node --test in-page-voice-test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { LiveManager } from '../src/live.mjs';
import { createApp } from '../src/server.mjs';
import { createInPageVoice } from '../src/in-page-voice.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, timeout = 4000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await predicate()) return true; await wait(25); } return false; };
class FakeSocket extends EventEmitter {
  readyState = 0; sent = [];
  constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.emit('open'); }); }
  send(text) { const event = JSON.parse(text); this.sent.push(event); if (event.type === 'session.close') queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } })))); }
  terminate() { this.readyState = 3; this.emit('close'); }
}

test('in-page voice: create via relay, heartbeat, stop, page loss, startup failure', { timeout: 30_000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'robomeet-single-hop-'));
  const created = [];       // bodies posted to the fake OpenAI
  const sockets = [];
  let sessionCounter = 0;
  const liveFactory = ({ store, present }) => new LiveManager({ store, present, apiKey: 'test-only-key', closeTimeoutMs: 30,
    fetchImpl: async (_url, init) => { created.push(JSON.parse(init.body)); const id = `live_${++sessionCounter}`; return { ok: true, json: async () => ({ session: { id }, transport: { sdp: `answer-${id}` } }) }; },
    socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; } });
  // Fake Meet page: what page.evaluate(fn, arg) would return for each RoboMeetLive call the controller makes.
  const page = { closed: false, connected: true, offerFails: false, accepted: [], closedReasons: [], offers: 0,
    isClosed() { return this.closed; },
    async evaluate(fn, arg) {
      const source = fn.toString();
      if (source.includes('createOffer')) { this.offers++; if (this.offerFails) throw new Error(this.offerError || 'Single-hop voice overlay is closed'); return 'v=0\r\nfake offer'; }
      if (source.includes('accept')) { this.accepted.push(arg); return { session: { connection: 'connecting' } }; }
      if (source.includes('health')) return { session: this.connected ? { connection: 'connected' } : null };
      if (source.includes('closeSession')) { this.closedReasons.push(arg); return 'closed'; }
      throw new Error(`unexpected evaluate: ${source.slice(0, 60)}`);
    } };
  const events = [];
  let controller;
  const workerFactory = ({ baseUrl, getState, onState }) => {
    const state = { status: 'joined', admitted: true, sharing: false, error: null, participants: 2, media: { input: 'active' } };
    setTimeout(() => onState({ ...state }), 0);
    controller = createInPageVoice({ baseUrl, dataDir, getState, getPage: () => page, emit: event => events.push(event), pollMs: 50, heartbeatMs: 60 });
    controller.start();
    return { async join() { return state; }, async leave() { return state; }, async present() { return state; }, async setMode() { return state; }, async close() { await controller.stop(); }, status: () => ({ ...state }), async diagnostics() { return state; } };
  };
  const app = await createApp({ port: 0, dataDir, liveFactory, workerFactory });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  await until(() => app.store.state.meeting.status === 'joined');
  await app.command({ type: 'voice-prompt', text: 'IDENTITY RULE: say I am Vivek Bot.' });
  await app.command({ type: 'context', text: 'Meeting context text.' });

  // 1. voice-start -> controller relays the page's offer with the bearer token and hands the answer back.
  await app.command({ type: 'voice-start' });
  assert.ok(await until(() => page.accepted.length === 1), 'answer handed to the page');
  assert.deepEqual(page.accepted[0], { id: 'live_1', sdp: 'answer-live_1' });
  assert.equal(created[0].transport.sdp, 'v=0\r\nfake offer');
  assert.match(created[0].session.instructions, /IDENTITY RULE: say I am Vivek Bot/, 'no prompt field => server uses voicePrompt');
  assert.equal(app.store.state.voice.sessionId, 'live_1');
  assert.equal(app.store.state.voice.status, 'connecting');
  sockets.at(-1).emit('message', Buffer.from(JSON.stringify({ type: 'session.started' })));
  assert.ok(await until(() => app.store.state.voice.status === 'active'), 'sideband session.started marks voice active without the renderer');

  // 2. Heartbeats reach src/live.mjs (lastHeartbeat advances).
  const record = app.live.sessions.get('live_1');
  const before = record.lastHeartbeat;
  await wait(200);
  assert.ok(record.lastHeartbeat > before, 'heartbeat posted by Node');

  // 3. voice-stop -> the page's session is closed and the paid session deleted.
  await app.command({ type: 'voice-stop' });
  assert.ok(await until(() => page.closedReasons.length === 1 && controller.status().sessionId === null));
  assert.equal(page.closedReasons[0], 'stop_requested');
  assert.equal(app.live.sessions.size, 0);
  assert.equal(app.store.state.voice.status, 'idle');

  // 4. Page connection lost mid-session -> session deleted at once, desired drops to stopped (attend.mjs can restart).
  await app.command({ type: 'voice-start' });
  assert.ok(await until(() => page.accepted.length === 2));
  page.connected = false;
  assert.ok(await until(() => app.live.sessions.size === 0 && app.store.state.voice.desired === 'stopped'));
  // The controller emits after its DELETE resolves, which can land after the store already shows the session gone.
  assert.ok(await until(() => events.some(event => event.type === 'live-session-ended' && event.reason === 'page_connection_lost')));
  page.connected = true;

  // 5a. Meeting audio not connected yet (knocking) -> quiet retry, no error, no relay call.
  page.offerFails = true; page.offerError = 'Meeting audio is not connected yet';
  await app.command({ type: 'voice-start' });
  assert.ok(await until(() => events.some(event => event.type === 'live-session-waiting')));
  await wait(150);
  assert.equal(app.store.state.voice.desired, 'started', 'still wanted while waiting for meeting audio');
  assert.equal(created.length, 2, 'no relay call while the page has no meeting audio');
  page.offerFails = false; page.offerError = null;
  assert.ok(await until(() => page.accepted.length === 3), 'session created once the page has audio');
  await app.command({ type: 'voice-stop' });
  assert.ok(await until(() => app.live.sessions.size === 0 && controller.status().sessionId === null));

  // 5b. Real startup failure in the page -> voice-status error (like public/live.js fail()), nothing left running.
  page.offerFails = true;
  await app.command({ type: 'voice-start' });
  assert.ok(await until(() => app.store.state.voice.status === 'error'));
  assert.equal(app.store.state.voice.desired, 'stopped');
  assert.match(app.store.state.voice.error, /overlay is closed/);
  assert.equal(app.live.sessions.size, 0);
  assert.equal(created.length, 3, 'no relay call when the page cannot produce an offer');
  page.offerFails = false;

  // 6. Worker close stops the controller; a later voice-start creates nothing.
  await controller.stop();
  await app.command({ type: 'voice-start' });
  await wait(200);
  assert.equal(created.length, 3);
});
