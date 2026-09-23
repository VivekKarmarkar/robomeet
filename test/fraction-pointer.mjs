// TC-F1..F3: a displayed formula with a stacked fraction can be boxed by what it says, not only by its number.
// The 2026-09-22 honest-tester baseline: "T = 2v0 sin θ / g" and "R = v0² sin 2θ / g" were "not on screen", so the
// only way to box them was the equation number, which boxes the whole derivation row. Two causes: the PDF has no "/"
// glyph for a fraction bar, and it emits a formula's words out of reading order (H's numerator before "H =").
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { wordPointer } from '../src/word-pointer.mjs';
import { wordsForDeck, wordsInView } from '../src/word-boxes.mjs';
import { findPhrase, wordsInside } from '../src/fine-pointer.mjs';
import { strokeOuterBox } from '../src/drawn-box.mjs';

const ROOT = new URL('../', import.meta.url).pathname;
const DECK = JSON.parse(await readFile(`${ROOT}public/slides/projectile-motion-deck/deck.json`, 'utf8'));
const WORDS = (await wordsForDeck(`${ROOT}public`, 'projectile-motion-deck')).pages[0].words;
const inView = v => wordsInView(WORDS, DECK.slides[0].views[v]);
const hits = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

// [part index, what a person or model says, words that must NOT be in the box]
const RESULTS = [
  [1, 'T = 2v0 sin θ / g', ['=⇒', '(7)']],
  [1, 'R = v0² sin 2θ / g', ['=⇒', '·', '(sin']],
  [2, 'R = v₀² sin 2θ/g', ['=⇒', '·', '(sin']],
  [1, 'H = v0² sin²θ / (2g)', ['=⇒', '(8)']],
  [0, 'y(x) = x tan θ − g x² / (2 v0² cos² θ)', ['From', 'Substitute', '(6)']],
  [0, 'g x² / (2 v0² cos² θ)', ['tan', '(6)']],
];

test('TC-F1: a stacked-fraction result is found by what it says, and only its own words are matched', () => {
  for (const [v, phrase, not] of RESULTS) {
    const hit = findPhrase(inView(v), phrase);
    assert.ok(hit, `"${phrase}" is found on part ${v + 1}`);
    for (const word of not) assert.ok(!hit.words.some(w => w.text === word), `"${phrase}" does not take in "${word}" (got "${hit.text}")`);
  }
});

test('TC-F2: the painted box around a fraction result holds the whole formula and clips nothing beside it', async () => {
  for (const [v, phrase] of RESULTS) {
    const view = DECK.slides[0].views[v];
    const found = await wordPointer({ publicDir: `${ROOT}public`, slug: 'projectile-motion-deck', slideIndex: 0, slide: DECK.slides[0], view, phrase });
    assert.ok(found, `"${phrase}" is pointed at on part ${v + 1}`);
    const hit = findPhrase(inView(v), phrase);
    const outer = strokeOuterBox({ rect: view, box: found.rect, asset: { width: 1920, height: 1080 } });
    const held = wordsInside(inView(v), found.rect, 0.5);
    for (const w of hit.words) assert.ok(held.includes(w), `"${w.text}" of "${phrase}" is inside the box`);
    const clipped = inView(v).filter(w => !hit.words.includes(w) && hits(outer, w)).map(w => w.text);
    assert.deepEqual(clipped, [], `the frame around "${phrase}" clips nothing`);
  }
});

test('TC-F3: plain prose and half-line terms still match exactly as before', () => {
  assert.equal(findPhrase(inView(0), 'ẏ(0) = v0 sin θ').text.normalize('NFC'), 'ẏ(0) = v 0 sin θ'.normalize('NFC'));
  assert.equal(findPhrase(inView(0), 'air resistance is neglected').text, 'air resistance is neglected.');
  assert.equal(findPhrase(inView(1), 'Mass never appears').text, 'Mass never appears.');
  assert.equal(findPhrase(inView(0), 'drag term'), null, 'a phrase that is not on screen is still not found');
});

test('TC-F4: a degree written with ° finds the PDF\'s ◦, and the second 45° is found by its own line', () => {
  const best = findPhrase(inView(2), 'θ = 45°');
  assert.ok(best, 'θ = 45° is found on part 3');
  assert.ok(best.text.includes('45'), `got "${best.text}"`);
  const second = findPhrase(inView(2), 'symmetric about 45°');
  assert.ok(second && second.words[0].y > best.words[0].y, 'the complementary-angles 45° is the lower line');
});

import { stageMap, DRAW_PAD_PX, STROKE_PX } from '../src/drawn-box.mjs';
test('TC-F5: when a neighbour is too close for a clear frame, the stroke never crosses the asked words (θ = 45°, then ",")', async () => {
  const view = DECK.slides[0].views[2];
  const found = await wordPointer({ publicDir: `${ROOT}public`, slug: 'projectile-motion-deck', slideIndex: 0, slide: DECK.slides[0], view, phrase: 'θ = 45°' });
  assert.ok(found, 'θ = 45° is pointed at');
  const hit = findPhrase(inView(2), 'θ = 45°');
  const map = stageMap({ rect: view, asset: { width: 1920, height: 1080 } });
  const inner = (DRAW_PAD_PX - STROKE_PX / 2);
  const x0 = found.rect.x - inner / map.sx, x1 = found.rect.x + found.rect.w + inner / map.sx;
  const half = 0.5 / map.sx; // rects are stored to 4 decimals, about 0.2 px
  for (const w of hit.words) assert.ok(w.x >= x0 - half && w.x + w.w <= x1 + half, `"${w.text}" is inside the stroke's inner edge`);
});
