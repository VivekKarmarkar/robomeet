// P1 (docs/problems/presenting-v1.md, TC-P1a-c): a delegated request is answered at once; the coding agent's result
// arrives later as its own cue, after the room is quiet, and survives a session restart. Fake GPT Live sideband.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.mjs';
import { LiveManager } from '../src/live.mjs';
import { roomQuiet } from '../src/late-results.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, timeout = 4000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (predicate()) return true; await wait(5); } return false; };
const events = (store, type) => store.state.events.filter(event => event.type === type).map(event => event.data);
// Acknowledges every instructions.append by id, like GPT Live.
class FakeSocket extends EventEmitter {
  readyState = 0; sent = [];
  constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.emit('open'); }); }
  send(text) {
    const event = JSON.parse(text); this.sent.push(event);
    if (event.type === 'session.close') queueMicrotask(() => this.message({ type: 'session.closed', usage: { duration_seconds: 1 } }));
    if (event.type === 'session.instructions.append' && event.event_id) queueMicrotask(() => this.message({ type: 'session.instructions.appended', client_event_id: event.event_id }));
  }
  message(event) { this.emit('message', Buffer.from(JSON.stringify(event))); }
  drop() { this.readyState = 3; this.emit('close', 1006, Buffer.alloc(0)); }
  terminate() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', 1006, Buffer.alloc(0)); }
}
async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'robomeet-late-'));
  const store = new Store(directory), sockets = [];
  let n = 0;
  const live = new LiveManager({ store, apiKey: 'test-only-key', closeTimeoutMs: 30, present: async () => ({ displayed: true }),
    lateOptions: { quietMs: 60, quietMaxMs: 2000, retryMs: 30 },
    fetchImpl: async () => ({ ok: true, json: async () => ({ session: { id: `live_${++n}` }, transport: { sdp: 'answer' } }) }),
    socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; }, ...options });
  t.after(async () => { await live.closeAll(); await rm(directory, { recursive: true, force: true }); });
  return { store, live, sockets };
}
const delegate = (live, id, callId, request) => {
  const record = live.sessions.get(id);
  const nested = event => live.receive(record, { type: 'response.event', delegation_id: `d_${callId}`, event });
  nested({ type: 'response.created', response: { id: `r_${callId}` } });
  nested({ type: 'response.output_item.done', item: { type: 'function_call', call_id: callId, name: 'ask_coding_agent', arguments: JSON.stringify({ request }) } });
  nested({ type: 'response.completed', response: { id: `r_${callId}` } });
};
const outputs = socket => socket.sent.filter(event => event.type === 'response.item.create').map(event => ({ callId: event.item.call_id, output: JSON.parse(event.item.output) }));
const cues = socket => socket.sent.filter(event => event.type === 'session.instructions.append' && /coding agent has finished|Before your voice session restarted/.test(event.content));
const FENCE = '"'.repeat(3);

test('TC-P1a: the call is answered at once with an acknowledgment, not when the coding agent replies', async t => {
  const { store, live, sockets } = await setup(t);
  await live.create({ sdp: 'offer' });
  const at = Date.now();
  delegate(live, 'live_1', 'c1', 'How many test files are there?');
  assert.ok(await until(() => outputs(sockets[0]).length === 1, 1000));
  assert.ok(Date.now() - at < 1000);
  const [{ output }] = outputs(sockets[0]);
  assert.equal(output.status, 'accepted');
  assert.match(output.note, /keep talking/);
  assert.equal(sockets[0].sent.filter(event => event.type === 'response.create').length, 1, 'the model gets its turn back');
  assert.equal(store.state.jobs[0].status, 'pending');
});

test('TC-P1b: the result is cued when the coding agent replies, after the room is quiet, with its text fenced', async t => {
  const { store, live, sockets } = await setup(t);
  await live.create({ sdp: 'offer' });
  delegate(live, 'live_1', 'c1', 'Count the "test" files');
  await until(() => store.state.jobs.length === 1);
  store.event('stage-input', { type: 'stage-input', phase: 'onset', at: Date.now() }); // someone is talking
  store.reply(store.state.jobs[0].id, 'There are 14 test files.');
  await wait(200);
  assert.equal(cues(sockets[0]).length, 0, 'no cue while a person speaks');
  store.event('stage-input', { type: 'stage-input', phase: 'end', at: Date.now() });
  assert.ok(await until(() => events(store, 'voice.job_result_delivered').length === 1));
  const [cue] = cues(sockets[0]);
  assert.match(cue.content, /^The coding agent has finished the request you handed over: "Count the 'test' files"\./);
  assert.ok(cue.content.endsWith(`${FENCE}There are 14 test files.${FENCE}`));
  const begin = sockets[0].sent.at(-1);
  assert.deepEqual([begin.type, begin.content], ['session.commentary.append', 'Begin now, following the instructions provided.']);
});

test('TC-P1b: a long result goes into context first, then a short cue', async t => {
  const { store, live, sockets } = await setup(t);
  await live.create({ sdp: 'offer' });
  delegate(live, 'live_1', 'c1', 'Summarize the README');
  await until(() => store.state.jobs.length === 1);
  store.reply(store.state.jobs[0].id, 'x'.repeat(2000));
  assert.ok(await until(() => events(store, 'voice.job_result_delivered').length === 1));
  const thinking = sockets[0].sent.filter(event => event.type === 'session.thinking.append');
  assert.ok(thinking.length >= 4 && thinking.every(event => event.content.length <= 450));
  assert.match(cues(sockets[0])[0].content, /full result was just added to your context/);
});

test('TC-P1c: a result that finishes after the session closed is told to the next session', async t => {
  const { store, live, sockets } = await setup(t);
  await live.create({ sdp: 'offer' });
  delegate(live, 'live_1', 'c1', 'Check the build');
  await until(() => store.state.jobs.length === 1);
  await live.close('live_1', 'renderer_disconnected');
  store.reply(store.state.jobs[0].id, 'The build passes.');
  await wait(50);
  assert.deepEqual(live.late.pending(), [store.state.jobs[0].id]);
  await live.create({ sdp: 'offer' });
  assert.ok(await until(() => events(store, 'voice.job_result_delivered').length === 1, 4000));
  const [cue] = cues(sockets[1]);
  assert.match(cue.content, /^Before your voice session restarted, you handed this request to the coding agent: "Check the build"/);
  assert.equal(events(store, 'voice.job_result_delivered')[0].sessionId, 'live_2');
});

test('TC-P1c: leaving the meeting forgets pending results; closing never leaks a store listener', async t => {
  const { store, live } = await setup(t);
  await live.create({ sdp: 'offer' });
  delegate(live, 'live_1', 'c1', 'Slow work');
  await until(() => store.state.jobs.length === 1);
  await live.closeAll('meeting_left');
  await wait(20);
  assert.deepEqual(live.late.pending(), []);
  assert.equal(store.listenerCount('change'), 0);
  store.reply(store.state.jobs[0].id, 'Finished after the call.');
  await wait(50);
  assert.equal(events(store, 'voice.job_result_delivered').length, 0);
});

test('TC-P1c: a cue that cannot be sent (control socket re-attaching) is retried and delivered', async t => {
  const { store, live, sockets } = await setup(t, { reattachDelaysMs: [150, 150, 150] });
  await live.create({ sdp: 'offer' });
  delegate(live, 'live_1', 'c1', 'Look it up');
  await until(() => store.state.jobs.length === 1);
  sockets[0].drop();
  store.reply(store.state.jobs[0].id, 'Found it.');
  assert.ok(await until(() => events(store, 'voice.job_result_delivered').length === 1, 4000));
  assert.equal(cues(sockets[1]).length, 1);
});

test('roomQuiet reads the latest meeting-audio and robot-speech phases', () => {
  const now = 100000;
  const ev = (type, phase, at) => ({ type, at: new Date(at).toISOString(), data: { phase, at } });
  assert.equal(roomQuiet([], now), true);
  assert.equal(roomQuiet([ev('stage-input', 'onset', now - 500)], now), false);
  assert.equal(roomQuiet([ev('stage-input', 'end', now - 500)], now), false);
  assert.equal(roomQuiet([ev('stage-input', 'end', now - 900)], now), true);
  assert.equal(roomQuiet([ev('stage-input', 'end', now - 900), ev('stage-speech', 'onset', now - 100)], now), false);
  assert.equal(roomQuiet([ev('stage-speech', 'onset', now - 200000)], now), true, 'a lost end expires');
});
