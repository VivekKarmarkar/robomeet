import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createApp, appDirectory } from '../src/server.mjs';

test('real stdio MCP bridge controls isolated app and preserves durable job cursors and reply identity', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'robomeet-mcp-'));
  let workerCallbacks;
  const modes = [], shares = [], closes = [];
  const app = await createApp({ port: 0, dataDir,
    workerFactory: callbacks => { workerCallbacks = callbacks; return {
      join: async ({ url }) => callbacks.onState({ status: 'joined', admitted: true, url }),
      leave: async () => callbacks.onState({ status: 'ended', admitted: false }),
      setMode: async mode => modes.push(mode), present: async value => shares.push(value),
    }; },
    liveFactory: () => ({ sessions: new Map(), closeAll: async reason => closes.push(reason), context() {}, setMode() {}, create() { throw new Error('Paid model calls are forbidden in this test'); } }),
  });
  const client = new Client({ name: 'robomeet-test-agent', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(appDirectory, 'bin/mcp.mjs')], cwd: appDirectory, env: { ROBO_URL: app.baseUrl, ROBO_DATA_DIR: dataDir }, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => { await client.close(); await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of ['status', 'join', 'leave', 'listen', 'reply', 'send_context', 'present', 'notes', 'voice', 'mode', 'slide']) assert.ok(names.includes(name), `${name} must be advertised`);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    return JSON.parse(result.content.find(item => item.type === 'text').text);
  };
  const initialStatus = await call('status');
  assert.equal(initialStatus.meeting.status, 'idle');
  assert.equal('events' in initialStatus, false, 'Routine MCP state must omit diagnostic event history');
  assert.equal((await call('send_context', { text: 'Review the parser during this meeting.' })).context, 'Review the parser during this meeting.');
  await call('join', { url: 'https://meet.google.com/abc-defg-hij', name: 'Test robot' });
  assert.equal((await call('voice', { enabled: true })).voice.desired, 'started'); // No renderer or model session exists in this isolated test.
  await call('voice', { enabled: false });
  await call('mode', { mode: 'listen' }); assert.deepEqual(modes, ['listen']);
  await call('present', { title: 'Review', slides: [{ title: 'One', body: 'First point' }, { title: 'Two', body: 'Second point' }], enabled: true });
  assert.equal(shares[0].enabled, true);
  assert.equal((await call('slide', { index: 1 })).slideIndex, 1);
  await call('notes', { text: 'Add a parser regression test.' });
  assert.equal((await call('notes')).notes.at(-1).text, 'Add a parser regression test.');
  const cursor = (await call('status')).cursor;
  const waiting = call('listen', { after: cursor, timeoutMs: 2000 });
  await new Promise(resolve => setTimeout(resolve, 25));
  const job = app.store.queueJob({ sessionId: 'live_original', callId: 'call_a', responseId: 'response_a', delegationId: 'delegation_a', request: 'Inspect the parser.' });
  const received = await waiting;
  assert.equal(received.events.find(event => event.type === 'agent.request').data.id, job.id);
  assert.equal(received.cursor, job.cursor ?? app.store.state.cursor);
  const second = app.store.queueJob({ sessionId: 'live_other', callId: 'call_a', responseId: 'response_b', delegationId: 'delegation_b', request: 'Unrelated task.' });
  await call('reply', { jobId: job.id, result: 'The parser drops empty strings.' });
  assert.equal(app.store.state.jobs.find(item => item.id === job.id).result, 'The parser drops empty strings.');
  assert.equal(app.store.state.jobs.find(item => item.id === second.id).status, 'pending');
  const resumed = await call('listen', { after: received.cursor, timeoutMs: 0 });
  assert.ok(resumed.events.some(event => event.type === 'agent.result' && event.data.id === job.id));
  const bad = await client.callTool({ name: 'reply', arguments: { jobId: 'not-a-job', result: 'No' } });
  assert.equal(bad.isError, true);
  const beforeTelemetry = app.store.state.cursor;
  workerCallbacks.onState({ ...app.store.state.meeting, media: { frames: 42 } });
  assert.equal(app.store.state.cursor, beforeTelemetry);
  await call('leave'); assert.ok(closes.includes('meeting_left'));
  assert.equal(stderr, '', 'MCP must not print credentials or diagnostics into its transport');
});
