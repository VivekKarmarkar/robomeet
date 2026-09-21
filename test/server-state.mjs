import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.mjs';
import { LiveManager } from '../src/live.mjs';
import { createApp } from '../src/server.mjs';

async function fixture(t) { const directory = await mkdtemp(join(tmpdir(), 'robomeet-test-')); t.roboCleanup = []; t.after(async () => { for (const cleanup of t.roboCleanup) await cleanup(); await rm(directory, { recursive: true, force: true }); }); return directory; }
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
class FakeSocket extends EventEmitter {
  readyState = 0;
  sent = [];
  constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.emit('open'); }); }
  send(text) { const event = JSON.parse(text); this.sent.push(event); if (event.type === 'session.close') queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ type: 'session.closed', usage: { duration_seconds: 1 } })))); }
  terminate() { this.readyState = 3; this.emit('close'); }
}
function manager(store, options = {}) {
  const sockets = [];
  const live = new LiveManager({ store, present: async () => ({ displayed: true }), apiKey: 'test-only-key', closeTimeoutMs: 30,
    fetchImpl: async () => ({ ok: true, json: async () => ({ session: { id: 'live_test' }, transport: { sdp: 'answer' } }) }),
    socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; }, ...options });
  return { live, sockets };
}
function nested(live, record, event) { live.receive(record, { type: 'response.event', delegation_id: 'delegation_test', event }); }

test('durable jobs deduplicate within their session and preserve exact reply correlation after restart', async t => {
  const directory = await fixture(t), store = new Store(directory);
  const params = { sessionId: 's1', callId: 'call1', responseId: 'r1', delegationId: 'd1', request: 'Inspect this code' };
  const first = store.queueJob(params);
  assert.equal(store.queueJob(params).id, first.id);
  const other = store.queueJob({ ...params, sessionId: 's2' });
  assert.notEqual(other.id, first.id);
  const restored = new Store(directory);
  restored.reply(first.id, 'Found the exact bug.');
  assert.equal(restored.state.jobs.find(job => job.id === other.id).status, 'pending');
  const cursor = restored.state.cursor;
  restored.reply(first.id, 'Found the exact bug.');
  assert.equal(restored.state.cursor, cursor);
  assert.throws(() => restored.reply(first.id, 'Contradictory result'), /different result/);
  assert.throws(() => restored.reply('wrong-id', 'result'), /Unknown job/);
  assert.equal(restored.readEvents(0).events.filter(event => event.type === 'agent.request').length, 2);
});

test('Responses tools run once and continue only after every correlated result is ready (blocking path, ROBO_ASYNC_JOBS=0)', async t => {
  const store = new Store(await fixture(t)); const { live, sockets } = manager(store, { asyncJobs: false }); t.roboCleanup.push(() => live.closeAll());
  await live.create({ sdp: 'offer' }); const record = live.sessions.get('live_test');
  nested(live, record, { type: 'response.created', response: { id: 'r1' } });
  const request = { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name: 'ask_coding_agent', arguments: '{"request":"Find a bug"}' } };
  nested(live, record, request); nested(live, record, request);
  nested(live, record, { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c2', name: 'take_note', arguments: '{"text":"Review the result"}' } });
  nested(live, record, { type: 'response.completed', response: { id: 'r1', output: [] } });
  await tick();
  assert.equal(store.state.jobs.length, 1);
  assert.equal(sockets[0].sent.filter(event => event.type === 'response.create').length, 0);
  store.reply(store.state.jobs[0].id, 'The parser skips empty strings.'); await tick();
  const sent = sockets[0].sent.filter(event => event.type.startsWith('response.'));
  assert.deepEqual(sent.map(event => event.type), ['response.item.create', 'response.item.create', 'response.create']);
  assert.deepEqual(sent.slice(0, 2).map(event => event.item.call_id), ['c1', 'c2']);
  assert.equal('delegation_id' in sent[2], false);
});

test('teardown closes the paid session, cancels waits and never sends a late agent result', async t => {
  const store = new Store(await fixture(t)); const { live, sockets } = manager(store);
  await live.create({ sdp: 'offer' }); const record = live.sessions.get('live_test');
  nested(live, record, { type: 'response.created', response: { id: 'r1' } });
  nested(live, record, { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name: 'ask_coding_agent', arguments: '{"request":"Slow work"}' } });
  nested(live, record, { type: 'response.completed', response: { id: 'r1' } });
  const result = await live.close('live_test');
  assert.equal(result.confirmed, true); assert.equal(live.sessions.size, 0);
  store.reply(store.state.jobs[0].id, 'Finished after the call.'); await tick();
  assert.equal(sockets[0].sent.filter(event => event.type === 'response.create').length, 0);
  assert.equal(store.listenerCount('change'), 0);
  assert.equal(store.state.jobs[0].status, 'completed');
});

test('Stop during HTTP session creation closes the resulting session instead of reviving voice', async t => {
  const store = new Store(await fixture(t)); let resolveFetch;
  const { live, sockets } = manager(store, { fetchImpl: () => new Promise(resolve => { resolveFetch = resolve; }) });
  const creation = live.create({ sdp: 'offer' });
  await live.closeAll('requested');
  resolveFetch({ ok: true, json: async () => ({ session: { id: 'live_test' }, transport: { sdp: 'answer' } }) });
  await assert.rejects(creation, /cancelled/);
  assert.equal(live.sessions.size, 0);
  assert.equal(store.state.voice.desired, 'stopped');
  assert.equal(sockets[0].sent.some(event => event.type === 'session.close'), true);
});

test('renderer heartbeat loss closes the paid session', async t => {
  const store = new Store(await fixture(t)); const { live } = manager(store, { heartbeatTimeoutMs: 20 });
  await live.create({ sdp: 'offer' });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(live.sessions.size, 0);
  assert.equal(store.state.voice.desired, 'stopped');
  assert.equal(store.state.events.find(event => event.type === 'voice.closed').data.reason, 'renderer_disconnected');
});

test('local API rejects unauthenticated and foreign-origin requests; media telemetry never wakes durable listeners', async t => {
  let callbacks; const closed = [];
  const app = await createApp({ port: 0, dataDir: await fixture(t), workerFactory: options => { callbacks = options; return { leave: async () => {}, join: async () => {}, present: async () => {} }; }, liveFactory: () => ({ sessions: new Map(), closeAll: async reason => closed.push(reason), setMode() {}, context() {} }) });
  t.roboCleanup.push(() => app.close());
  assert.equal((await fetch(`${app.baseUrl}/api/state`)).status, 401);
  const headers = { Authorization: `Bearer ${app.token}` };
  assert.equal((await fetch(`${app.baseUrl}/api/state`, { headers })).status, 200);
  assert.equal((await fetch(`${app.baseUrl}/api/state`, { headers: { ...headers, Origin: 'https://unrelated.example' } })).status, 403);
  callbacks.onState({ status: 'joined', admitted: true, media: { frames: 1 } });
  const cursor = app.store.state.cursor;
  callbacks.onState({ status: 'joined', admitted: true, media: { frames: 2 } });
  assert.equal(app.store.state.cursor, cursor);
  assert.equal(app.store.snapshot().meeting.media.frames, 2);
  callbacks.onState({ status: 'removed', admitted: false });
  assert.ok(closed.includes('meeting_ended'));
  await app.command({ type: 'join', url: 'https://meet.google.com/abc-defg-hij' });
  assert.equal(app.store.state.meeting.status, 'launching');
});

test('HTTP voice boundary preserves browser SDP byte-for-byte, including its final CRLF', async t => {
  let offered;
  const app = await createApp({ port: 0, dataDir: await fixture(t), workerFactory: () => ({ leave: async () => {} }), liveFactory: () => ({
    sessions: new Map(), closeAll: async () => {}, setMode() {}, context() {},
    create: async ({ sdp }) => { offered = sdp; return { id: 'live_boundary_test', sdp: 'answer\r\n' }; },
  }) });
  t.roboCleanup.push(() => app.close());
  const headers = { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' };
  await app.command({ type: 'voice-start', preview: true });
  const sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n';
  const response = await fetch(`${app.baseUrl}/api/live/sessions`, { method: 'POST', headers, body: JSON.stringify({ sdp }) });
  assert.equal(response.status, 201);
  assert.equal(offered, sdp);
  assert.equal(Buffer.compare(Buffer.from(offered), Buffer.from(sdp)), 0);
  assert.equal((await response.json()).sdp, 'answer\r\n');
});

test('sideband diagnostics are bounded structural metadata and exclude reflected audio and private payloads', async t => {
  const store = new Store(await fixture(t)); const { live } = manager(store); t.roboCleanup.push(() => live.closeAll());
  await live.create({ sdp: 'offer' }); const record = live.sessions.get('live_test');
  live.receive(record, { type: 'session.input_audio.append', audio: 'private-audio-payload' });
  live.receive(record, { type: 'session.output_audio.delta', delta: 'private-audio-payload' });
  for (let i = 0; i < 100; i++) live.receive(record, { type: `diagnostic_${i}`, secret: 'test-only-key', content: 'private-diagnostic-payload' });
  const diagnostics = store.state.events.filter(event => event.type === 'voice.protocol');
  assert.equal(diagnostics.length, 80);
  const text = JSON.stringify(diagnostics);
  assert.equal(text.includes('private-audio-payload'), false);
  assert.equal(text.includes('private-diagnostic-payload'), false);
  assert.equal(text.includes('test-only-key'), false);
  assert.equal(text.includes('session.input_audio.append'), false);
});

test('filtered listeners wait through transcript chunks and advance cursors without losing matching pages', async t => {
  const store = new Store(await fixture(t));
  let settled = false;
  const waiting = store.listen(0, 500, undefined, ['agent.request']).then(result => { settled = true; return result; });
  store.event('transcript', { text: 'An unfinished sentence' });
  await tick(); assert.equal(settled, false);
  const job = store.queueJob({ sessionId: 's', callId: 'c', responseId: 'r', request: 'Read the file' });
  const result = await waiting;
  assert.deepEqual(result.events.map(event => event.type), ['agent.request']);
  assert.equal(result.events[0].data.id, job.id);
  store.event('transcript', { text: 'Another fragment' });
  const timeout = await store.listen(result.cursor, 30, undefined, ['agent.request']);
  assert.deepEqual(timeout.events, []);
  assert.equal(timeout.cursor, store.state.cursor);
  store.note('one'); store.event('transcript', { text: 'gap' }); store.note('two');
  const first = store.readEvents(timeout.cursor, 1, ['note.added']);
  const second = store.readEvents(first.cursor, 1, ['note.added']);
  assert.equal(first.events[0].data.text, 'one');
  assert.equal(second.events[0].data.text, 'two');
});
