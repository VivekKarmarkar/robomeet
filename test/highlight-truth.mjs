// The robot must never claim to have boxed something it did not box (live test 7, 2026-09-19: asked for the initial
// vertical velocity, it boxed both velocity components and said it had boxed only the vertical one).
// TC-V1 word boxes exist and are page-normalized. TC-V2 a phrase resolves to exactly its own words, not its line.
// TC-V3 the painted rectangle is the stage's, padding included. TC-V4 the oracle catches the test-7 claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseWordBoxes, wordBoxesForPdf, wordsInView } from '../src/word-boxes.mjs';
import { findPhrase, wordsInside, norm } from '../src/fine-pointer.mjs';
import { stageMap, paintedBox, paintedPixels, pngSize, DRAW_PAD_PX } from '../src/drawn-box.mjs';
import { auditHighlight } from '../src/highlight-oracle.mjs';

const PDF = new URL('../docs/projectile-motion/projectile_motion.pdf', import.meta.url).pathname;
const DECK = JSON.parse(await readFile(new URL('../public/slides/projectile-motion-deck/deck.json', import.meta.url), 'utf8'));
const VIEW = DECK.slides[0].views[0];
const RECT = { x: VIEW.x, y: VIEW.y, w: VIEW.w, h: VIEW.h };
const ASSET = { width: 1920, height: 1080 };
const pages = await wordBoxesForPdf(PDF, 1);
const WORDS = wordsInView(pages[0].words, RECT);
// The line that made the robot lie: it carries BOTH velocity components.
const BOTH_COMPONENTS = DECK.slides[0].views[0].lines.find(line => norm(line.text).includes('cos') && norm(line.text).includes('sin'));

test('TC-V1: word boxes are parsed page-normalized, and the view filter keeps only what is on screen', async () => {
  assert.ok(pages[0].words.length > 300, 'the page has word boxes');
  for (const word of pages[0].words.slice(0, 50)) {
    assert.ok(word.text.length, 'every word has text');
    for (const key of ['x', 'y', 'w', 'h']) assert.ok(Number.isFinite(word[key]) && word[key] >= 0 && word[key] <= 1, `${key} is normalized`);
  }
  assert.ok(WORDS.length && WORDS.length < pages[0].words.length, 'the view holds some but not all of the page');
  for (const word of WORDS) assert.ok(word.y + word.h > RECT.y && word.y < RECT.y + RECT.h, 'every kept word overlaps the view');
  assert.deepEqual(parseWordBoxes('<page width="100" height="200"><word xMin="10" yMin="20" xMax="30" yMax="40">hi</word></page>'),
    [{ width: 100, height: 200, words: [{ text: 'hi', x: 0.1, y: 0.1, w: 0.2, h: 0.1 }] }]);
  assert.deepEqual(parseWordBoxes('<page width="100" height="200"><word xMin="10" yMin="20" xMax="10" yMax="40"> </word></page>')[0].words, [], 'empty and zero-width words are dropped');
});

test('TC-V2: a phrase boxes exactly its own words, not the whole line it sits on', () => {
  assert.ok(BOTH_COMPONENTS, 'the deck has the line carrying both components');
  const hit = findPhrase(WORDS, 'ẏ(0) = v 0 sin θ');
  assert.ok(hit, 'the vertical component is found');
  assert.equal(norm(hit.text), norm('ẏ(0) = v 0 sin θ'), 'exactly the asked words, nothing more');
  assert.ok(hit.rect.w < BOTH_COMPONENTS.w * 0.6, `the box (${hit.rect.w}) is well under the line (${BOTH_COMPONENTS.w})`);
  assert.ok(hit.rect.x > BOTH_COMPONENTS.x, 'it starts to the right of the line start: the horizontal component is excluded');
  // The horizontal component is a different box on the same line.
  const other = findPhrase(WORDS, 'ẋ(0) = v 0 cos θ');
  assert.ok(other && other.rect.x < hit.rect.x, 'the two components resolve to different boxes');
  assert.ok(other.rect.x + other.rect.w <= hit.rect.x + 1e-9, 'and they do not overlap');
  assert.equal(findPhrase(WORDS, 'no such words anywhere on this page'), null, 'text that is not there is refused');
  assert.equal(findPhrase([], 'anything'), null);
});

test('TC-V3: the painted rectangle is the stage rectangle, its frame padding included', () => {
  const map = stageMap({ rect: RECT, asset: ASSET });
  assert.equal(map.sx, 1920, 'a fit-width view spans the stage');
  assert.ok(Math.abs(map.sy - 1080 / RECT.h) < 1e-6, 'y scales by the view height');
  assert.equal(map.ox, 0); assert.equal(map.oy, 0);
  const box = { x: 0.5, y: 0.3, w: 0.1, h: 0.01 };
  const px = paintedPixels(map, box);
  // Exactly meet-stage.js drawHighlight.
  assert.ok(Math.abs(px.x - (map.ox + (box.x - map.rect.x) * map.sx - DRAW_PAD_PX)) < 1e-9);
  assert.ok(Math.abs(px.w - (box.w * map.sx + DRAW_PAD_PX * 2)) < 1e-9);
  const painted = paintedBox({ rect: RECT, box, asset: ASSET });
  assert.ok(painted.w > box.w && painted.h > box.h, 'the painted box is larger than the resolved box');
  assert.ok(painted.padX > painted.padY, 'the pad is anisotropic: a wide crop stretched onto a 16:9 stage');
  assert.ok(Math.abs((painted.h - box.h) * map.sy - DRAW_PAD_PX * 2) < 1e-6, 'the frame adds exactly its padding, top and bottom');
  assert.equal(paintedBox({ rect: RECT, box: null, asset: ASSET }), null);
  assert.equal(pngSize(Buffer.alloc(4)), null, 'a non-PNG has no size');
});

test('TC-V4: the oracle reports what the box really holds, and refuses the test-7 claim', () => {
  const phrase = 'ẏ(0) = v 0 sin θ';
  const hit = findPhrase(WORDS, phrase);
  // A. the word-level box: exactly right, and honest about the edge.
  const good = auditHighlight({ words: WORDS, box: hit.rect, rect: RECT, asset: ASSET, asked: hit.words, phrase });
  assert.equal(good.verified, true);
  assert.equal(good.exact, true, 'exactly the asked words are inside');
  assert.deepEqual(good.extra, [], 'nothing unasked is inside');
  assert.deepEqual(good.missing, [], 'nothing asked is outside');
  assert.match(good.say, /You may say you boxed|admit the edge/, 'it is allowed to claim the box');
  // B. the line-level box that actually shipped in test 7: the claim must be refused.
  const bad = auditHighlight({ words: WORDS, box: { x: BOTH_COMPONENTS.x, y: BOTH_COMPONENTS.y, w: BOTH_COMPONENTS.w, h: BOTH_COMPONENTS.h }, rect: RECT, asset: ASSET, asked: hit.words, phrase });
  assert.equal(bad.exact, false, 'the line box is NOT what was asked for');
  assert.ok(bad.extra.length, 'the horizontal component came along');
  assert.ok(norm(bad.extra.map(w => w.text).join(' ')).includes('cos'), 'and it is named');
  assert.match(bad.say, /Do not claim you boxed only what was asked/, 'the model is told not to over-claim');
  assert.match(bad.say, /actually contains/);
  // C. no word boxes: claim nothing at all.
  const blind = auditHighlight({ words: [], box: hit.rect, rect: RECT, asset: ASSET, asked: hit.words, phrase });
  assert.equal(blind.verified, false);
  assert.match(blind.say, /cannot be checked|Do not claim/);
  // D. nothing boxed.
  assert.match(auditHighlight({ words: WORDS, box: null, rect: RECT, asset: ASSET }).say, /Nothing is boxed/);
});

test('TC-V4: wordsInside is an area test, so a grazed word is not counted as inside', () => {
  const words = [{ text: 'in', x: 0.2, y: 0.2, w: 0.05, h: 0.01 }, { text: 'edge', x: 0.29, y: 0.2, w: 0.05, h: 0.01 }];
  const rect = { x: 0.19, y: 0.19, w: 0.11, h: 0.03 }; // covers 'in' fully, 'edge' by a fifth
  assert.deepEqual(wordsInside(words, rect, 0.5).map(w => w.text), ['in']);
  assert.deepEqual(wordsInside(words, rect, 0.01).map(w => w.text), ['in', 'edge']);
  assert.deepEqual(wordsInside(words, null), []);
});

// TC-V5: the watcher. A drawn box must reach the model as a FACT on the thinking channel, and a box that is not what
// was asked for must also reach it as an INSTRUCTION, because the commentary channel is trained to paraphrase
// (live-delegation, "Send the right kind of update") and a paraphrase of a word list is how the false claim returns.
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { watchPointerTruth, truthOfHighlight, ONLY_WHAT_YOU_ARE_TOLD } from '../src/screen-truth.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, timeout = 3000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (predicate()) return true; await wait(10); } return false; };

async function bench(t) {
  const dir = await mkdtemp(join(tmpdir(), 'robomeet-truth-'));
  const publicDir = join(dir, 'public');
  await mkdir(join(publicDir, 'slides', 'pm'), { recursive: true });
  await copyFile(new URL('../public/slides/projectile-motion-deck/deck.json', import.meta.url), join(publicDir, 'slides', 'pm', 'deck.json'));
  const store = new Store(dir);
  const facts = [], orders = [];
  const live = { activeSession: () => ({ id: 's' }), context: text => { facts.push(text); return true; }, instruct: async text => { orders.push(text); return true; } };
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  // The deck as the server holds it, with the view's exact render and a box on view 0.
  const slides = [{ title: 'Projectile Motion', page: 1, views: DECK.slides[0].views.map((view, i) => ({ x: view.x, y: view.y, w: view.w, h: view.h, asset: `/slides/pm/page-1-view-${i + 1}.png` })) }];
  return { store, live, facts, orders, publicDir, slides };
}

test('TC-V5: a box that is exactly what was asked for is stated as a fact, with no prohibition', async t => {
  const { store, live, facts, orders, publicDir, slides } = await bench(t);
  const stop = watchPointerTruth({ store, live, publicDir, phraseOf: () => 'ẏ(0) = v 0 sin θ', debounceMs: 5 });
  t.after(stop);
  const hit = findPhrase(wordsInView(pages[0].words, RECT), 'ẏ(0) = v 0 sin θ');
  slides[0].views[0].highlight = hit.rect;
  store.update({ deckSlug: 'pm', slides, pointer: { slide: 0, view: 0, previous: null } }, 'presentation.pointer', {});
  assert.ok(await until(() => facts.length > 0), 'a fact was sent');
  assert.match(facts[0], /^About the box on your shared screen:/);
  assert.match(facts[0].normalize('NFC'), /contains exactly/);
  assert.equal(orders.length, 0, 'nothing to prohibit: the box is right');
  assert.ok(facts[0].length < 1800, 'well inside the 500-token per-append cap');
});

test('TC-V5: the test-7 box reaches the model as a fact AND as a prohibition it cannot paraphrase away', async t => {
  const { store, live, facts, orders, publicDir, slides } = await bench(t);
  const stop = watchPointerTruth({ store, live, publicDir, phraseOf: () => 'ẏ(0) = v 0 sin θ', debounceMs: 5 });
  t.after(stop);
  slides[0].views[0].highlight = { x: BOTH_COMPONENTS.x, y: BOTH_COMPONENTS.y, w: BOTH_COMPONENTS.w, h: BOTH_COMPONENTS.h };
  store.update({ deckSlug: 'pm', slides, pointer: { slide: 0, view: 0, previous: null } }, 'presentation.pointer', {});
  assert.ok(await until(() => orders.length > 0), 'a prohibition was sent');
  assert.match(facts[0], /actually contains/);
  assert.match(orders[0], /Do not claim you boxed only what was asked/, 'the over-claim is forbidden');
  assert.ok(orders[0].normalize('NFC').includes('cos'), 'it names the component that came along');
  // The one rule that covers the other false claims the adversarial suite found: mechanism, staleness, recalled text.
  assert.match(orders[0], /do not describe how the pointer chooses what to box/);
  assert.match(orders[0], /whether the box has moved or is unchanged/);
  assert.match(orders[0], /do not supply text or a formula that RoboMeet has not shown you/);
});

test('TC-V5: no words for the deck means the robot is told to claim nothing', async t => {
  const { store, live, publicDir, slides } = await bench(t);
  slides[0].views[0].highlight = { x: 0.5, y: 0.25, w: 0.1, h: 0.01 };
  // slug 'missing' has no deck.json, so there are no word boxes to check against.
  const verdict = await truthOfHighlight({ state: { deckSlug: 'missing', slides, pointer: { slide: 0, view: 0 } }, publicDir, phrase: 'anything' });
  assert.equal(verdict.verified, false);
  assert.match(verdict.say, /cannot be checked|Do not claim/);
  assert.match((await truthOfHighlight({ state: { slides, pointer: null }, publicDir })).say, /Nothing is boxed/);
});

test('TC-V5: the standing rule is one rule, and short enough for the 500-token append cap', () => {
  // Test 7 and the adversarial suite produced four different false claims with one cause: the robot narrating screen
  // facts nobody gave it. One rule, not four patches.
  for (const forbidden of [/how the pointer chooses/, /has moved or is unchanged/, /not shown you/]) assert.match(ONLY_WHAT_YOU_ARE_TOLD, forbidden);
  assert.ok(ONLY_WHAT_YOU_ARE_TOLD.length < 700, `${ONLY_WHAT_YOU_ARE_TOLD.length} chars is well inside 500 tokens`);
});

test('TC-V2: a phrase written with typographic maths still finds the plain PDF words', () => {
  // A live run: the robot asked to box "ẏ(0) = v₀ sin θ" (subscript zero); the PDF text is "v 0". It must still match.
  for (const typed of ['ẏ(0) = v₀ sin θ', 'v₀ sin θ', 'ẏ(0)=v₀sinθ']) {
    const hit = findPhrase(WORDS, typed);
    assert.ok(hit, `"${typed}" is found`);
    assert.equal(norm(hit.text).replace(/\s/g, ''), norm('ẏ(0) = v 0 sin θ').replace(/\s/g, '').slice(-norm(hit.text).replace(/\s/g, '').length), `"${typed}" boxes only the vertical component, got "${hit.text}"`);
    assert.ok(!/cos/.test(hit.text), 'and never the cosine term');
  }
  assert.equal(norm('v₀²'), 'v02', 'subscripts and superscripts fold to plain digits');
});
