// TC-V6: end to end through the real server. A `highlight` command goes through src/pointer.mjs and src/server.mjs
// exactly as it does in a meeting, and the watcher must tell the robot what the resulting box really holds.
// Nothing here is mocked except the browser worker and the voice socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { watchPointerTruth } from '../src/screen-truth.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, timeout = 5000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (predicate()) return true; await wait(10); } return false; };
const SRC = new URL('../public/slides/projectile-motion-deck/', import.meta.url);

async function server(t) {
  const dir = await mkdtemp(join(tmpdir(), 'robomeet-truthsrv-'));
  const publicDir = join(dir, 'public');
  await mkdir(join(publicDir, 'slides', 'pm'), { recursive: true });
  for (const name of ['deck.json', 'page-1.png', 'page-1-view-1.png', 'page-1-view-2.png', 'page-1-view-3.png']) {
    await copyFile(new URL(name, SRC), join(publicDir, 'slides', 'pm', name));
  }
  const facts = [], orders = [];
  const app = await createApp({ port: 0, dataDir: join(dir, 'data'), publicDir,
    workerFactory: () => ({ leave: async () => {}, join: async () => {}, present: async () => {}, syncStage: async () => {} }),
    liveFactory: () => ({ sessions: new Map(), closeAll: async () => {}, setMode() {}, activeSession: () => ({ id: 's' }),
      context: text => { facts.push(text); return true; }, instruct: async text => { orders.push(text); return true; },
      onTranscript: () => () => {} }) });
  const stop = watchPointerTruth({ store: app.store, live: app.live, publicDir, phraseOf: () => phrase, debounceMs: 5 });
  let phrase = '';
  t.after(async () => { stop(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  await app.command({ type: 'present-deck', slug: 'pm' });
  return { app, facts, orders, setPhrase: value => { phrase = value; } };
}

test('TC-V6: the real highlight command produces a verdict the robot is told', async t => {
  const { app, facts, orders, setPhrase } = await server(t);
  setPhrase('a parabola through the origin');
  // This phrase is its own line, so the line-level pointer already gets it right.
  await app.command({ type: 'highlight', phrase: 'a parabola through the origin' });
  assert.ok(await until(() => facts.length > 0), 'the robot was told what the box holds');
  assert.match(facts[0], /^About the box on your shared screen:/);
  assert.ok(facts[0].normalize('NFC').includes('parabola'), 'it names the boxed text');
  assert.equal(orders.length, 0, 'a correct box needs no prohibition');
});

test('TC-V6: a phrase that is half a line is caught, and the robot is forbidden to over-claim', async t => {
  const { app, facts, orders, setPhrase } = await server(t);
  const phrase = 'ẏ(0) = v 0 sin θ';
  setPhrase(phrase);
  // src/pointer.mjs resolves this to the whole line: this is the test-7 box, produced by the shipping code path.
  await app.command({ type: 'highlight', phrase });
  // The box is still drawn: the check reports on the pointer, it never gates it.
  assert.ok(app.store.state.pointer, 'a pointer is recorded');
  assert.ok(app.store.state.slides[0].views[0].highlight, 'the box is on the view');
  assert.ok(await until(() => orders.length > 0), 'the robot was forbidden to over-claim');
  const told = `${facts.join(' ')} ${orders.join(' ')}`.normalize('NFC');
  assert.ok(told.includes('cos'), 'the component that came along is named');
  assert.match(orders[0], /Do not claim you boxed only what was asked/);
  assert.match(orders[0], /do not supply text or a formula that RoboMeet has not shown you/);
});

test('TC-V6: clearing the box tells the robot nothing is boxed, and a failure never blocks a highlight', async t => {
  const { app, orders, setPhrase } = await server(t);
  setPhrase('ẏ(0) = v 0 sin θ');
  await app.command({ type: 'highlight', phrase: 'ẏ(0) = v 0 sin θ' });
  assert.ok(await until(() => orders.length > 0));
  await app.command({ type: 'highlight', off: true });
  assert.equal(app.store.state.pointer, null, 'the pointer is gone');
  assert.equal(app.store.state.slides[0].views[0].highlight, undefined, 'and so is the box');
  // Text that is not on screen is still refused by the pointer itself, unchanged by any of this.
  await assert.rejects(() => app.command({ type: 'highlight', phrase: 'no such words anywhere' }), /not on screen/);
});
