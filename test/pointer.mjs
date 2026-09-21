// P3 (docs/problems/presenting-v1.md, TC-P3a/b): the pointer. Resolution against the real projectile deck's line
// boxes, the server's highlight command (set, clear, cleared by a move), narrate beats with a highlight, and the
// voice model's point_at tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePointer, equationNumber, slideLines } from '../src/pointer.mjs';
import { createApp } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { LiveManager } from '../src/live.mjs';

const DECK = new URL('../public/slides/projectile-motion-deck/deck.json', import.meta.url);
const deck = JSON.parse(await readFile(DECK, 'utf8'));
const part1 = deck.slides[0].views[0];
const inside = (rect, line) => line.x >= rect.x && line.y >= rect.y && line.x + line.w <= rect.x + rect.w + 1e-4 && line.y + line.h <= rect.y + rect.h + 1e-4;
const lineNamed = text => slideLines(deck.slides[0]).find(line => line.text.normalize('NFC') === text.normalize('NFC'));

test('equation numbers are read the way people say them', () => {
  for (const [text, number] of [['(3)', '3'], ['3', '3'], ['equation 3', '3'], ['Eq. (12)', '12'], [' ( 7 ) ', '7'], ['(2a)', '2a']]) assert.equal(equationNumber(text), number);
  for (const text of ['range', '3 results', '']) assert.equal(equationNumber(text), null);
});

test('TC-P3a: an equation number boxes its whole row, label to number, and nothing else', () => {
  const { rect, how } = resolvePointer({ slide: deck.slides[0], view: part1, request: { equation: '(3)' } });
  assert.equal(how, 'equation');
  for (const text of ['Initial conditions:', 'x(0) = 0, y(0) = 0,', 'ẋ(0) = v 0 cos θ, ẏ(0) = v 0 sin θ', '(3)']) assert.ok(inside(rect, lineNamed(text)), `${text} is inside`);
  for (const text of ['m ÿ = −mg', '(2)', 'The two directions are uncoupled : gravity touches only y. Each equation integrates on its own.']) assert.ok(!inside(rect, lineNamed(text)), `${text} is outside`);
});

test('TC-P3a: a phrase is boxed where it is on screen; text off screen or unknown is refused', () => {
  const found = resolvePointer({ slide: deck.slides[0], view: part1, request: { phrase: 'a parabola through the origin' } });
  assert.equal(found.how, 'phrase');
  assert.ok(inside(found.rect, lineNamed('a parabola through the origin.')));
  assert.match(resolvePointer({ slide: deck.slides[0], view: part1, request: { phrase: 'Complementary angles' } }).error, /not on screen/);
  assert.match(resolvePointer({ slide: deck.slides[0], view: part1, request: { equation: '9' } }).error, /Equation \(9\) is not on screen/);
  assert.match(resolvePointer({ slide: { views: [{ x: 0, y: 0, w: 1, h: 1 }] }, view: { x: 0, y: 0, w: 1, h: 1 }, request: { phrase: 'x' } }).error, /no text positions/);
  assert.deepEqual(resolvePointer({ slide: null, view: part1, request: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 } }), { rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, how: 'rect' });
});

async function app(t) {
  const directory = await mkdtemp(join(tmpdir(), 'robomeet-pointer-'));
  const publicDir = join(directory, 'public');
  await mkdir(join(publicDir, 'slides', 'pm'), { recursive: true });
  await copyFile(DECK, join(publicDir, 'slides', 'pm', 'deck.json'));
  const syncs = [];
  const created = await createApp({ port: 0, dataDir: join(directory, 'data'), publicDir,
    workerFactory: () => ({ leave: async () => {}, join: async () => {}, present: async () => {}, syncStage: async () => { syncs.push(structuredClone(created.store.state.slides[0].views.map(view => view.highlight || null))); } }),
    liveFactory: () => ({ sessions: new Map(), closeAll: async () => {}, setMode() {}, context() {}, activeSession: () => null, onTranscript: () => () => {} }) });
  t.after(async () => { await created.close(); await rm(directory, { recursive: true, force: true }); });
  await created.command({ type: 'present-deck', slug: 'pm' });
  return { app: created, syncs };
}

test('TC-P3a: the highlight command draws on the view on screen, is cleared by off, and by the next move', async t => {
  const { app: server, syncs } = await app(t);
  await server.command({ type: 'highlight', equation: '(3)' });
  const views = () => server.store.state.slides[0].views;
  assert.ok(views()[0].highlight, 'part 1 has the box');
  assert.equal(server.store.state.viewIndex, 0, 'the screen did not move');
  assert.ok(syncs.at(-1)[0], 'the stage was synced with the box');
  await server.command({ type: 'highlight', off: true });
  assert.equal(views()[0].highlight, undefined);
  await server.command({ type: 'highlight', phrase: 'Integrate twice' });
  assert.ok(views()[0].highlight);
  await server.command({ type: 'stage', slide: 0, view: 1 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(views()[0].highlight, undefined, 'a move clears the pointer');
  assert.equal(server.store.state.pointer, null);
  await assert.rejects(() => server.command({ type: 'highlight', phrase: 'no such words anywhere' }), /not on screen/);
});

test('TC-P3b: a narrated beat can carry a highlight; an over-long beat is refused with its length (TC-P7b)', async t => {
  const { app: server } = await app(t);
  await server.command({ type: 'narrate', beats: [{ slide: 0, view: 1, say: 'The three results.', highlight: 'Three results' }] }).catch(() => {});
  assert.ok(server.store.state.slides[0].views[1].highlight, 'the beat view has its box');
  await assert.rejects(() => server.command({ type: 'narrate', beats: [{ slide: 0, view: 0, say: 'x'.repeat(950) }] }), /is 950 characters; the limit is 900/);
});

test('TC-P3b: the voice model points with point_at through the backend; off clears', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'robomeet-pointat-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const live = new LiveManager({ store: new Store(directory), apiKey: 'k', present: async () => ({}), pointAt: async request => { calls.push(request); return { pointed: true }; } });
  const record = { id: 's', abort: new AbortController() };
  assert.deepEqual(await live.execute(record, {}, { name: 'point_at', call_id: 'c', arguments: JSON.stringify({ target: 'equation (3)' }) }), { pointed: true });
  await live.execute(record, {}, { name: 'point_at', call_id: 'd', arguments: JSON.stringify({ target: 'off' }) });
  assert.deepEqual(calls, [{ phrase: 'equation (3)' }, { off: true }]);
  await assert.rejects(() => live.execute(record, {}, { name: 'point_at', call_id: 'e', arguments: JSON.stringify({ target: ' ' }) }), /Say what to point at/);
});
