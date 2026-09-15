import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageDeck, stagePosition, assetsAround, assetFile, createStageSync, slideAsset } from '../src/stage-sync.mjs';

const state = {
  title: 'Deck',
  slideIndex: 0,
  viewIndex: 1,
  slides: [
    { title: 'Page 1', body: 'image:/slides/d/page-1.png', views: [{ x: 0, y: 0, w: 1, h: 0.4, asset: '/slides/d/page-1-view-1.png' }, { x: 0, y: 0.5, w: 1, h: 0.4, asset: '/slides/d/page-1-view-2.png', say: 'ignored by the stage', highlight: { x: 0.1, y: 0.6, w: 0.3, h: 0.05 } }] },
    { title: 'Text', body: 'Hello' },
    { title: 'Evil', body: 'image:/slides/../../etc/passwd.png' },
  ],
};

test('stageDeck maps store slides to stage slides and refuses unsafe pictures', () => {
  const deck = stageDeck(state);
  assert.equal(deck.slides[0].kind, 'image');
  assert.equal(deck.slides[0].asset, '/slides/d/page-1.png');
  assert.deepEqual(deck.slides[0].views[1], { x: 0, y: 0.5, w: 1, h: 0.4, highlight: { x: 0.1, y: 0.6, w: 0.3, h: 0.05 }, asset: '/slides/d/page-1-view-2.png' });
  assert.equal(deck.slides[1].kind, 'text');
  assert.equal(deck.slides[1].body, 'Hello');
  assert.equal(deck.slides[2].kind, 'text', 'a path with .. is never loaded as a picture');
});

test('stagePosition clamps and assetsAround prefetches neighbours', () => {
  const deck = stageDeck(state);
  assert.deepEqual(stagePosition(state, deck), { slide: 0, view: 1 });
  assert.deepEqual(stagePosition({ ...state, slideIndex: 9, viewIndex: 9 }, deck), { slide: 2, view: 0 });
  assert.equal(stagePosition({ slides: [] }), null);
  assert.deepEqual(assetsAround(deck, { slide: 0, view: 1 }).sort(), ['/slides/d/page-1-view-1.png', '/slides/d/page-1-view-2.png', '/slides/d/page-1.png'].sort());
});

test('assetFile stays inside public/slides', () => {
  assert.equal(assetFile('/app/public', '/slides/a/b.png'), '/app/public/slides/a/b.png');
  assert.throws(() => assetFile('/app/public', '/slides/../x.png'));
  assert.throws(() => assetFile('/app/public', '/etc/passwd'));
});

test('createStageSync pushes needed pictures, stages the deck before showing, clears when empty', async () => {
  const publicDir = await mkdtemp(join(tmpdir(), 'stage-sync-'));
  await mkdir(join(publicDir, 'slides/d'), { recursive: true });
  for (const name of ['page-1.png', 'page-1-view-1.png', 'page-1-view-2.png']) await writeFile(join(publicDir, 'slides/d', name), Buffer.from(name));
  const calls = [];
  const assets = new Set();
  globalThis.window = { RoboMeetStage: {
    health: () => ({ slides: 0, assets: assets.size, instance: 'page-1' }),
    configure: config => { calls.push(['configure', config.speechEndMs]); return config; },
    hasAssets: ids => ids.filter(id => assets.has(id)),
    putAsset: (id, data) => { calls.push(['put', id, typeof data]); assets.add(id); return { id }; },
    setDeck: deck => { calls.push(['setDeck', deck.slides.length]); return { slides: deck.slides.length }; },
    show: position => { calls.push(['show', position.slide, position.view]); return { changedAt: 1, slide: position.slide, view: position.view, kind: 'none' }; },
    clear: () => { calls.push(['clear']); return true; },
  } };
  const page = { isClosed: () => false, evaluate: async (fn, arg) => fn(arg) };
  let current = state;
  const events = [];
  const sync = createStageSync({ getPage: () => page, getState: () => current, publicDir, emit: event => events.push(event) });
  await sync.sync(); // resolves once the view is shown
  assert.ok(calls.some(call => call[0] === 'show'), 'shown when sync() resolves');
  await sync.settled(); // the neighbour prefetch finishes inside the same run
  assert.deepEqual(calls[0], ['configure', 350], 'a new page instance is configured first');
  // Ids carry the file version after '#', so a rebuilt deck with the same names is re-sent.
  assert.ok(calls.filter(call => call[0] === 'put').every(call => /#\d+-\d+$/.test(call[1])), 'versioned ids');
  assert.deepEqual(calls.filter(call => call[0] === 'put').map(call => call[1].split('#')[0]).sort(), ['/slides/d/page-1-view-1.png', '/slides/d/page-1-view-2.png', '/slides/d/page-1.png'].sort());
  assert.ok(calls.filter(call => call[0] === 'put').every(call => call[2] === 'object'), 'bytes are sent as a Uint8Array');
  const order = calls.map(call => call[0]);
  const putAt = path => calls.findIndex(call => call[0] === 'put' && call[1].startsWith(`${path}#`));
  // The shown position's pictures, then the deck, then show; the neighbour is prefetched after the move.
  assert.ok(putAt('/slides/d/page-1.png') < order.indexOf('setDeck') && putAt('/slides/d/page-1-view-2.png') < order.indexOf('setDeck'), 'pictures of the shown view, then deck');
  assert.ok(order.indexOf('setDeck') < order.indexOf('show'), 'deck, then show');
  assert.ok(putAt('/slides/d/page-1-view-1.png') > order.indexOf('show'), 'the neighbour after the move');
  assert.equal(events.at(-1).type, 'stage-shown');
  calls.length = 0;
  await sync.sync();
  assert.equal(calls.length, 0, 'an unchanged store does nothing');
  current = { ...state, viewIndex: 0 };
  await sync.sync();
  assert.deepEqual(calls, [['show', 0, 0]]);
  current = { slides: [] };
  calls.length = 0;
  await sync.sync();
  assert.deepEqual(calls, [['clear']]);
  delete globalThis.window;
});

test('a missing picture is reported once and does not stop the stage; a rebuilt file is sent again', async () => {
  const publicDir = await mkdtemp(join(tmpdir(), 'stage-sync-'));
  await mkdir(join(publicDir, 'slides/d'), { recursive: true });
  await writeFile(join(publicDir, 'slides/d/page-1.png'), Buffer.from('v1'));
  const calls = [], assets = new Set();
  globalThis.window = { RoboMeetStage: {
    health: () => ({ slides: 0, assets: assets.size, instance: 'page-1' }),
    configure: config => config,
    hasAssets: ids => ids.filter(id => assets.has(id)),
    putAsset: id => { calls.push(['put', id]); assets.add(id); return { id }; },
    setDeck: deck => { calls.push(['setDeck', deck.slides[0].asset]); return { slides: deck.slides.length }; },
    show: position => { calls.push(['show', position.slide, position.view]); return { changedAt: 1, ...position, kind: 'none' }; },
    clear: () => true,
  } };
  const page = { isClosed: () => false, evaluate: async (fn, arg) => fn(arg) };
  const events = [];
  let current = { title: 'D', slideIndex: 0, viewIndex: 0, slides: [{ title: 'p1', body: 'image:/slides/d/page-1.png', views: [{ x: 0, y: 0, w: 1, h: 0.5, asset: '/slides/d/gone.png' }] }] };
  const sync = createStageSync({ getPage: () => page, getState: () => current, publicDir, emit: event => events.push(event) });
  await sync.sync();
  assert.ok(calls.some(call => call[0] === 'show'), 'the stage still shows the slide');
  assert.equal(events.filter(event => event.type === 'stage-asset-error').length, 1);
  await sync.sync();
  assert.equal(events.filter(event => event.type === 'stage-asset-error').length, 1, 'reported once');
  // Rebuild: same name, new bytes and mtime -> a new id is sent.
  const first = calls.find(call => call[0] === 'put')[1];
  await new Promise(resolve => setTimeout(resolve, 20));
  await writeFile(join(publicDir, 'slides/d/page-1.png'), Buffer.from('version-2'));
  current = { ...current, slides: structuredClone(current.slides) }; // the same deck, layout and names (a rebuild of the same PDF)
  await sync.sync();
  const second = calls.filter(call => call[0] === 'put').at(-1)[1];
  assert.equal(second.split('#')[0], '/slides/d/page-1.png');
  assert.notEqual(second, first);
  assert.equal(calls.filter(call => call[0] === 'setDeck').at(-1)[1], second, 'the page deck points at the new picture, not the cached one');
  delete globalThis.window;
});

test('a sync() that arrives during a run resolves only after a run that saw the state it was called for', async () => {
  const publicDir = await mkdtemp(join(tmpdir(), 'stage-sync-'));
  await mkdir(join(publicDir, 'slides/d'), { recursive: true });
  for (const name of ['page-1.png', 'page-1-view-1.png', 'page-1-view-2.png']) await writeFile(join(publicDir, 'slides/d', name), Buffer.from(name));
  const started = [], shown = [];
  globalThis.window = { RoboMeetStage: {
    health: () => ({ instance: 'page-1' }), configure: config => config, hasAssets: ids => ids, putAsset: id => ({ id }),
    setDeck: deck => ({ slides: deck.slides.length }), clear: () => true,
    show: position => { started.push(position.view); return new Promise(resolve => setTimeout(() => { shown.push(position.view); resolve({ changedAt: 1, ...position, kind: 'none' }); }, 60)); },
  } };
  const page = { isClosed: () => false, evaluate: async (fn, arg) => fn(arg) };
  let current = { ...state, viewIndex: 0 };
  const sync = createStageSync({ getPage: () => page, getState: () => current, publicDir });
  const first = sync.sync();
  while (!started.length) await new Promise(resolve => setTimeout(resolve, 2)); // run 1 has read the state and is showing view 0
  current = { ...state, viewIndex: 1 };
  await sync.sync();
  assert.deepEqual(shown, [0, 1], 'view 1 is on the stage when the awaited sync() resolves');
  await first;
  delete globalThis.window;
});

test('image paths as people write them reach the stage; SVG and outside paths get a clear text slide', () => {
  assert.equal(slideAsset(' slides/a b.png '), '/slides/a b.png');
  assert.equal(slideAsset('/public/slides/Screenshot%20from%202026-09-14.png'), '/slides/Screenshot from 2026-09-14.png');
  assert.equal(slideAsset('/slides/x.png?v=3'), '/slides/x.png');
  const deck = stageDeck({ slides: [{ body: 'image:slides/diagram.gif' }, { body: 'image:/slides/logo.svg' }, { body: 'image:/slides/%2e%2e/secret.png' }, { body: 'image:/etc/passwd' }] });
  assert.deepEqual(deck.slides.map(slide => slide.kind), ['image', 'text', 'text', 'text']);
  assert.equal(deck.slides[0].asset, '/slides/diagram.gif');
  assert.match(deck.slides[1].body, /^An SVG picture cannot be shared directly/);
  assert.match(deck.slides[2].body, /^Picture not allowed: \/slides\/\.\.\/secret\.png/, 'percent-encoded .. is decoded, then refused');
  assert.throws(() => assetFile('/app/public', '/slides/../secret.png'));
  // A '#' in a name would be read as a version, and /Slides/ is another folder on this disk: both are refused, never blank.
  const odd = stageDeck({ slides: [{ body: 'image:/slides/Slide%20%233.png' }, { body: 'image:/Slides/x.png' }] });
  assert.deepEqual(odd.slides.map(slide => slide.kind), ['text', 'text']);
});

test('a picture that vanishes for a moment during a rebuild keeps the stage on its last picture', async () => {
  const publicDir = await mkdtemp(join(tmpdir(), 'stage-sync-'));
  await mkdir(join(publicDir, 'slides/d'), { recursive: true });
  await writeFile(join(publicDir, 'slides/d/page-1.png'), Buffer.from('v1'));
  const calls = [], assets = new Set(), events = [];
  globalThis.window = { RoboMeetStage: {
    health: () => ({ instance: 'page-1' }), configure: config => config, hasAssets: ids => ids.filter(id => assets.has(id)),
    putAsset: id => { calls.push(['put', id]); assets.add(id); return { id }; },
    setDeck: deck => { calls.push(['setDeck', deck.slides[0].asset]); return {}; }, show: position => { calls.push(['show']); return { changedAt: 1, ...position, kind: 'none' }; }, clear: () => true,
  } };
  const page = { isClosed: () => false, evaluate: async (fn, arg) => fn(arg) };
  const current = { title: 'D', slideIndex: 0, viewIndex: 0, slides: [{ title: 'p1', body: 'image:/slides/d/page-1.png', views: [] }] };
  const sync = createStageSync({ getPage: () => page, getState: () => current, publicDir, emit: event => events.push(event) });
  await sync.sync(); await sync.settled();
  const decks = () => calls.filter(call => call[0] === 'setDeck');
  const { rm } = await import('node:fs/promises');
  await rm(join(publicDir, 'slides/d/page-1.png')); // the builder's rm, before its rename
  await sync.sync(); await sync.settled();
  assert.equal(decks().length, 1, 'no new deck with a missing picture');
  assert.equal(events.filter(event => event.type === 'stage-asset-error').length, 0);
  await new Promise(resolve => setTimeout(resolve, 20));
  await writeFile(join(publicDir, 'slides/d/page-1.png'), Buffer.from('version-2')); // the rename lands
  await sync.sync(); await sync.settled();
  assert.equal(decks().length, 2, 'the rebuilt picture is staged');
  assert.notEqual(decks()[1][1], decks()[0][1]);
  delete globalThis.window;
});

test('a page reload during a push is a stage error, not a bad picture', async () => {
  const publicDir = await mkdtemp(join(tmpdir(), 'stage-sync-'));
  await mkdir(join(publicDir, 'slides/d'), { recursive: true });
  await writeFile(join(publicDir, 'slides/d/page-1.png'), Buffer.from('v1'));
  globalThis.window = { RoboMeetStage: {
    health: () => ({ instance: 'page-1' }), configure: config => config, hasAssets: () => [],
    putAsset: () => { throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation'); },
    setDeck: () => ({}), show: position => ({ changedAt: 1, ...position, kind: 'none' }), clear: () => true,
  } };
  const page = { isClosed: () => false, evaluate: async (fn, arg) => fn(arg) };
  const events = [];
  const current = { title: 'D', slideIndex: 0, viewIndex: 0, slides: [{ title: 'p1', body: 'image:/slides/d/page-1.png', views: [] }] };
  const sync = createStageSync({ getPage: () => page, getState: () => current, publicDir, emit: event => events.push(event) });
  await sync.sync(); await sync.settled();
  assert.deepEqual(events.map(event => event.type), ['stage-error']);
  delete globalThis.window;
});
