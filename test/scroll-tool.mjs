// TC-V9: the robot moves its own screen. Before this, "scroll down" was the one thing it could not do: it had four
// tools and none of them touched the stage, so a scroll went voice model -> backend -> coding agent -> MCP -> server,
// seconds for something the server does in under a millisecond. This is the resolver, the tool, and the end-to-end
// move through the real server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveScroll, positions } from '../src/scroll-target.mjs';
import { createApp } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { LiveManager } from '../src/live.mjs';

const DECK = new URL('../public/slides/projectile-motion-deck/', import.meta.url);
const slides = [{ views: [0, 1, 2] }, { views: [0, 1] }]; // page 1 has three parts, page 2 has two
const at = (slide, view, target) => resolveScroll({ slides, slideIndex: slide, viewIndex: view, target });

test('TC-V9: the words people actually say resolve to a place on the deck', () => {
  assert.deepEqual(positions(slides).length, 5, 'five screens in reading order');
  for (const [target, slide, view] of [['next', 0, 1], ['down a bit', 0, 1], ['further down', 0, 1], ['continue', 0, 1],
    ['the top', 0, 0], ['beginning', 0, 0], ['the end', 1, 1], ['bottom', 1, 1],
    ['part 3', 0, 2], ['section two', 0, 1], ['page 2', 1, 0], ['page 2 part 2', 1, 1], ['three', 0, 2], ['down two', 0, 2]]) {
    const got = at(0, 0, target);
    assert.deepEqual([got.slide, got.view], [slide, view], `${target} -> ${slide}/${view}, got ${got.slide}/${got.view} ${got.error || ''}`);
  }
});

test('TC-V9: scrolling walks across a page boundary, and stops at both ends', () => {
  assert.deepEqual([at(0, 2, 'next').slide, at(0, 2, 'next').view], [1, 0], 'past the last part of page 1 is page 2');
  assert.deepEqual([at(1, 0, 'back').slide, at(1, 0, 'back').view], [0, 2], 'and back again');
  assert.match(at(1, 1, 'next').error, /already at the end/);
  assert.match(at(0, 0, 'back').error, /already at the top/);
  assert.match(at(0, 0, 'page 9').error, /no page 9; the document has 2/);
  assert.match(at(0, 0, 'part 9').error, /has 3 parts/);
  assert.match(at(0, 0, 'sideways').error, /not a place on the document/);
  assert.match(at(0, 0, '').error, /Say where to scroll/);
  assert.match(resolveScroll({ slides: [], target: 'next' }).error, /Nothing is on the shared screen/);
});

test('TC-V9: the voice model calls scroll and the screen really moves', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'robomeet-scroll-'));
  const publicDir = join(dir, 'public');
  await mkdir(join(publicDir, 'slides', 'pm'), { recursive: true });
  for (const n of ['deck.json', 'page-1.png', 'page-1-view-1.png', 'page-1-view-2.png', 'page-1-view-3.png']) await copyFile(new URL(n, DECK), join(publicDir, 'slides', 'pm', n));
  let captured = null;
  const app = await createApp({ port: 0, dataDir: join(dir, 'data'), publicDir,
    workerFactory: () => ({ leave: async () => {}, join: async () => {}, present: async () => {}, syncStage: async () => {} }),
    liveFactory: options => { captured = options; return { sessions: new Map(), closeAll: async () => {}, setMode() {}, activeSession: () => null, context() {}, onTranscript: () => () => {} }; } });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  await app.command({ type: 'present-deck', slug: 'pm' });
  assert.ok(captured.scrollTo, 'the server hands the live session a scrollTo');

  const one = await captured.scrollTo('next');
  assert.deepEqual([one.moved, one.slide, one.view], [true, 0, 1], 'the screen moved one part down');
  assert.equal(app.store.state.viewIndex, 1, 'and the store agrees');
  assert.deepEqual([one.page, one.part, one.parts], [1, 2, 3], 'it reports where it landed in human terms');
  const last = await captured.scrollTo('the end');
  assert.equal(app.store.state.viewIndex, 2);
  const again = await captured.scrollTo('the end');
  assert.equal(again.moved, false, 'already there is not an error');
  assert.match(again.note, /already there/);
  await assert.rejects(() => captured.scrollTo('next'), /already at the end/);
  await assert.rejects(() => captured.scrollTo('sideways'), /not a place on the document/);
  await captured.scrollTo('the top');
  assert.equal(app.store.state.viewIndex, 0);
});

test('TC-V9: the scroll tool is offered to the model and refuses an empty target', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'robomeet-scrolltool-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  const live = new LiveManager({ store: new Store(dir), apiKey: 'k', present: async () => ({}), scrollTo: async to => { calls.push(to); return { moved: true }; } });
  const record = { id: 's', abort: new AbortController() };
  assert.deepEqual(await live.execute(record, {}, { name: 'scroll', call_id: 'c', arguments: JSON.stringify({ to: 'next' }) }), { moved: true });
  await live.execute(record, {}, { name: 'scroll', call_id: 'd', arguments: JSON.stringify({ to: 'page 2' }) });
  assert.deepEqual(calls, ['next', 'page 2']);
  await assert.rejects(() => live.execute(record, {}, { name: 'scroll', call_id: 'e', arguments: JSON.stringify({ to: ' ' }) }), /Say where to scroll/);
  // Without a scrollTo wired in, the tool says so rather than pretending.
  const blind = new LiveManager({ store: new Store(dir), apiKey: 'k', present: async () => ({}) });
  await assert.rejects(() => blind.execute(record, {}, { name: 'scroll', call_id: 'f', arguments: JSON.stringify({ to: 'next' }) }), /not available/);
});
