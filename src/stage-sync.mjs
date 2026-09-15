// Worker side of the stage (docs/stage-design.md): mirrors the store's presentation (title, slides, slideIndex,
// viewIndex) into window.RoboMeetStage inside the Meet page (src/meet-stage.js).
//   - image slides ("image:/slides/...") and exact view renders are read from public/slides and pushed into the page
//     as base64 bytes, only around the current position (current, previous, next), so big decks stay light;
//   - text slides are drawn by the stage itself;
//   - sync() is called by the server on every presentation change (event-driven, so next/previous reach the page in
//     milliseconds) and by a 500 ms poll as a fallback; runs never overlap and a change during a run is re-read.
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

// Every format createImageBitmap decodes in Chrome (a GIF shows its first frame).
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif' };
// A picture under public/slides (names may have spaces and punctuation; never .., //, backslashes or control chars).
const ASSET = /^\/slides\/[^\\\u0000-\u001f]+\.(png|jpe?g|webp|gif|bmp|avif)$/i;
// "image:" paths as people write them: slides/x.png, /public/slides/x.png, percent-encoded names, a ?v= cache buster.
export function slideAsset(raw) {
  let path = String(raw ?? '').trim().replace(/[?#].*$/, '');
  try { path = decodeURIComponent(path); } catch { /* keep it as written */ }
  if (path.startsWith('/public/')) path = path.slice(7);
  else if (path.startsWith('public/')) path = path.slice(6);
  if (path.startsWith('slides/')) path = `/${path}`;
  return path;
}
// The folder is matched case-sensitively (public/slides on a case-sensitive disk); a '#' would be read as a version.
const safeAsset = path => typeof path === 'string' && path.length <= 500 && path.startsWith('/slides/') && ASSET.test(path) && !path.includes('..') && !path.includes('//') && !path.includes('#');
export const isSlideAsset = safeAsset; // the server keeps view renders by the same rule
// In-page ids carry the file version (size and mtime), so a rebuilt deck with the same file names never shows the old
// pictures from the page's cache. assetFile() takes either form. Only the version suffix is removed.
const pathOf = id => String(id).replace(/#(?:\d+-\d+|missing)$/, '');

// Store presentation -> stage deck. Pure; unit-tested.
export function stageDeck(state = {}) {
  const slides = Array.isArray(state.slides) ? state.slides : [];
  return {
    title: String(state.title || ''),
    slides: slides.map(slide => {
      const body = typeof slide?.body === 'string' ? slide.body.trim() : '';
      const image = body.startsWith('image:') ? slideAsset(body.slice(6)) : null;
      const views = Array.isArray(slide?.views) ? slide.views.map(view => ({
        x: view.x, y: view.y, w: view.w, h: view.h,
        ...(view.highlight ? { highlight: view.highlight } : {}),
        ...(safeAsset(slideAsset(view.asset)) ? { asset: slideAsset(view.asset) } : {}),
      })) : [];
      if (image && safeAsset(image)) return { kind: 'image', asset: image, title: slide.title || '', body: '', views };
      const refused = !image ? body
        : /\.svg$/i.test(image) ? `An SVG picture cannot be shared directly: ${image}. Save it as PNG, or build a deck from the page or PDF that contains it.`
        : `Picture not allowed: ${image} (use a PNG, JPEG, WebP, GIF, BMP or AVIF file under public/slides).`;
      return { kind: 'text', asset: null, title: slide?.title || '', body: refused, views: [] };
    }),
  };
}
export function stagePosition(state = {}, deck = stageDeck(state)) {
  if (!deck.slides.length) return null;
  const slide = Math.min(Math.max(0, Number(state.slideIndex) || 0), deck.slides.length - 1);
  const views = deck.slides[slide].views.length || 1;
  const view = Math.min(Math.max(0, Number(state.viewIndex) || 0), views - 1);
  return { slide, view };
}
// Asset ids needed to show `position` and its neighbours without waiting.
export function assetsAround(deck, position, neighbours = true) {
  const ids = new Set();
  const add = (slide, view) => {
    const item = deck.slides[slide];
    if (!item) return;
    if (item.asset) ids.add(item.asset);
    const asset = item.views[view]?.asset;
    if (asset) ids.add(asset);
  };
  const { slide, view } = position;
  add(slide, view);
  if (!neighbours) return [...ids];
  const views = deck.slides[slide].views.length || 1;
  if (view + 1 < views) add(slide, view + 1); else add(slide + 1, 0);
  if (view > 0) add(slide, view - 1); else if (slide > 0) add(slide - 1, Math.max(0, (deck.slides[slide - 1].views.length || 1) - 1));
  return [...ids];
}
export function assetFile(publicDir, id) {
  const path = pathOf(id);
  if (!safeAsset(path)) throw new Error(`Refusing slide asset ${path}`);
  const root = resolve(publicDir, 'slides');
  const file = resolve(publicDir, '.' + path);
  if (!file.startsWith(root + sep)) throw new Error(`Refusing slide asset ${id}`);
  return file;
}

export function createStageSync({ getPage, getState, publicDir, emit = () => {}, pollMs = 500, stageConfig = { speechEndMs: 350 } }) {
  let instance = null; // RoboMeetStage.health().instance: a new one means the Meet page reloaded
  let deckSignature = null;
  let positionSignature = null;
  let running = null; // the run in progress
  let queued = null; // the run after it, shared by every sync() that arrived meanwhile
  let timer = null;
  let lastError = null;
  const versions = new Map(); // path -> "size-mtimeMs", read when a deck is (re)loaded
  const missing = new Set(); // assets already reported missing for this deck
  async function version(path) {
    try { const info = await stat(assetFile(publicDir, path)); return `${info.size}-${Math.round(info.mtimeMs)}`; }
    catch { return 'missing'; }
  }
  let plainSignature = null;
  async function versioned(deck) {
    const paths = new Set();
    for (const slide of deck.slides) { if (slide.asset) paths.add(slide.asset); for (const view of slide.views) if (view.asset) paths.add(view.asset); }
    // Same deck as before: a file that is missing now but had a version keeps it (a rebuild swaps the folder with
    // rm then rename; a poll between the two must not blank the screen). A new deck reads every version afresh.
    const same = JSON.stringify(deck) === plainSignature;
    if (!same) { versions.clear(); plainSignature = JSON.stringify(deck); }
    await Promise.all([...paths].map(async path => {
      const now = await version(path);
      if (now === 'missing' && same && versions.has(path) && versions.get(path) !== 'missing') return;
      versions.set(path, now);
    }));
    const id = path => (path ? `${path}#${versions.get(path) || 'missing'}` : path);
    return { ...deck, slides: deck.slides.map(slide => ({ ...slide, asset: id(slide.asset), views: slide.views.map(view => (view.asset ? { ...view, asset: id(view.asset) } : view)) })) };
  }

  async function once(onShown = () => {}) {
    const page = getPage();
    if (!page || page.isClosed()) return;
    const ready = await page.evaluate(() => Boolean(window.RoboMeetStage)).catch(() => false);
    if (!ready) return;
    // A reloaded Meet page starts with an empty stage: forget what we believed it held, and configure it again.
    const health = await page.evaluate(() => window.RoboMeetStage.health());
    if (health.instance !== instance) {
      instance = health.instance;
      deckSignature = null;
      positionSignature = null;
      await page.evaluate(config => window.RoboMeetStage.configure(config), stageConfig);
    }
    const state = getState();
    const plain = stageDeck(state);
    const position = stagePosition(state, plain);
    // The signature carries each file's version: a rebuilt deck keeps its file names and often its layout, and must
    // still reach the page with new ids (else the page shows the pictures it cached for the old ids).
    const deck = await versioned(plain);
    const signature = JSON.stringify(deck);
    if (signature !== deckSignature) missing.clear();
    if (!position) {
      if (deckSignature !== 'empty') { await page.evaluate(() => window.RoboMeetStage.clear()); deckSignature = 'empty'; positionSignature = null; emit({ type: 'stage-cleared' }); }
      return;
    }
    const push = async ids => {
      if (!ids.length) return;
      const present = new Set(await page.evaluate(ids => window.RoboMeetStage.hasAssets(ids), ids));
      for (const id of ids) {
        if (present.has(id) || missing.has(id)) continue;
        // One missing or undecodable picture must not stop the stage: report it once and show the rest.
        try {
          const bytes = await readFile(assetFile(publicDir, id));
          // A Uint8Array crosses page.evaluate as bytes (a Node Buffer would arrive as a plain object).
          await page.evaluate(([id, data, mime]) => window.RoboMeetStage.putAsset(id, data, mime), [id, new Uint8Array(bytes), MIME[extname(pathOf(id)).toLowerCase()] || 'image/png']);
        } catch (error) {
          if (/Execution context was destroyed|Target .*closed|navigat/i.test(String(error?.message))) throw error;
          missing.add(id);
          emit({ type: 'stage-asset-error', asset: pathOf(id), message: String(error.message).split('\n')[0].slice(0, 200) });
        }
      }
    };
    // The pictures of the position to show go first; the neighbours are prefetched after the move, so a page
    // crossing does not wait for the next page's pictures (about 140 ms each, measured).
    const needed = assetsAround(deck, position);
    const here = assetsAround(deck, position, false);
    await push(here);
    if (signature !== deckSignature) {
      await page.evaluate(deck => window.RoboMeetStage.setDeck(deck), deck);
      deckSignature = signature;
      positionSignature = null;
    }
    const where = `${position.slide}:${position.view}`;
    if (where !== positionSignature) {
      const shown = await page.evaluate(position => window.RoboMeetStage.show(position), position);
      positionSignature = where;
      emit({ type: 'stage-shown', slide: shown.slide, view: shown.view, kind: shown.kind, at: shown.changedAt });
    }
    onShown();
    await push(needed.filter(id => !here.includes(id)));
  }
  async function run(onShown) {
    try { await once(onShown); lastError = null; }
    catch (error) {
      const message = String(error.message).split('\n')[0].slice(0, 300);
      if (message !== lastError) emit({ type: 'stage-error', message });
      lastError = message;
    } finally { onShown(); }
  }
  // Runs never overlap. A sync() resolves when its run has shown the position (the neighbours are still being
  // prefetched inside that run); a sync() during a run resolves after the next run, which starts after it and so sees
  // the state it was called for.
  function sync() {
    if (!running) {
      let onShown;
      const shown = new Promise(resolve => { onShown = resolve; });
      running = run(onShown).finally(() => { running = null; });
      return shown;
    }
    queued ??= running.then(() => { queued = null; return sync(); });
    return queued;
  }
  function start() {
    if (timer) return;
    timer = setInterval(() => void sync(), pollMs);
    timer.unref?.();
  }
  function stop() { clearInterval(timer); timer = null; instance = null; deckSignature = null; positionSignature = null; }
  function reset() { instance = null; deckSignature = null; positionSignature = null; }
  // Resolves when no run is in progress or queued (the neighbour prefetch included): for tests and teardown.
  async function settled() { while (running || queued) await (queued || running); }
  return { sync, settled, start, stop, reset };
}

