// TC-T1..T3: the box around a term is tight and clips nothing it was not asked to box.
// Live test 7 and the 2026-09-22 simulated-tester run: the box around "ẏ(0) = v 0 sin θ" was 84 px tall around a
// 26 px line and cut through the "θ," of the cosine term beside it. Two causes: a 0.02-of-page minimum size meant for
// views, and a 14 px frame. Both are now tight, and the word pointer keeps the frame clear of every neighbour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { wordPointer } from '../src/word-pointer.mjs';
import { wordsForDeck, wordsInView } from '../src/word-boxes.mjs';
import { findPhrase } from '../src/fine-pointer.mjs';
import { strokeOuterBox, stageMap, DRAW_PAD_PX, STROKE_PX } from '../src/drawn-box.mjs';

const ROOT = new URL('../', import.meta.url).pathname;
const DECK = JSON.parse(await readFile(`${ROOT}public/slides/projectile-motion-deck/deck.json`, 'utf8'));
const WORDS = await wordsForDeck(`${ROOT}public`, 'projectile-motion-deck');
const unit = v => Math.min(1, Math.max(0, v));
const cleanHighlight = r => { const w = Math.max(0.002, unit(r.w)), h = Math.max(0.002, unit(r.h)); return { x: Math.min(1 - w, unit(r.x)), y: Math.min(1 - h, unit(r.y)), w, h }; };
const hits = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

// Terms a person really asks for, across all three parts: half-lines, whole equations, and boxed results.
const CASES = [
  [0, 'ẏ(0) = v 0 sin θ'], [0, 'ẋ(0) = v 0 cos θ'], [0, 'm ÿ = −mg'], [0, 'm ẍ = 0'], [0, 'x(0) = 0'],
  [0, 'a parabola through the origin'], [1, 'Time of flight'], [1, 'Maximum height'], [2, 'Range'], [2, 'Best angle'],
];

test('TC-T1: the painted frame around a term clips no word it was not asked to box', async () => {
  for (const [v, phrase] of CASES) {
    const view = DECK.slides[0].views[v];
    const found = await wordPointer({ publicDir: `${ROOT}public`, slug: 'projectile-motion-deck', slideIndex: 0, slide: DECK.slides[0], view, phrase });
    assert.ok(found, `"${phrase}" is found on part ${v + 1}`);
    const outer = strokeOuterBox({ rect: view, box: cleanHighlight(found.rect), asset: { width: 1920, height: 1080 } });
    const inView = wordsInView(WORDS.pages[0].words, view);
    const mine = findPhrase(inView, phrase).words;
    const clipped = inView.filter(w => !mine.includes(w) && hits(outer, w)).map(w => w.text);
    assert.deepEqual(clipped, [], `"${phrase}": the frame clips ${JSON.stringify(clipped)}`);
  }
});

test('TC-T2: the frame hugs the term: about the line height, not three times it', async () => {
  const view = DECK.slides[0].views[0];
  const found = await wordPointer({ publicDir: `${ROOT}public`, slug: 'projectile-motion-deck', slideIndex: 0, slide: DECK.slides[0], view, phrase: 'ẏ(0) = v 0 sin θ' });
  const map = stageMap({ rect: view, asset: { width: 1920, height: 1080 } });
  const outer = strokeOuterBox({ rect: view, box: cleanHighlight(found.rect), asset: { width: 1920, height: 1080 } });
  const lineH = 0.0106 * map.sy, boxH = outer.h * map.sy;
  assert.ok(boxH < lineH * 1.8, `the frame is ${boxH.toFixed(0)} px tall around a ${lineH.toFixed(0)} px line`);
  // A comma the request did not include is not boxed.
  const cos = await wordPointer({ publicDir: `${ROOT}public`, slug: 'projectile-motion-deck', slideIndex: 0, slide: DECK.slides[0], view, phrase: 'ẋ(0) = v 0 cos θ' });
  const theta = wordsInView(WORDS.pages[0].words, view).find(w => w.text === 'θ,' && Math.abs(w.x - 0.6339) < 0.01);
  assert.ok(cos.rect.x + cos.rect.w < theta.x + theta.w - 0.001, 'the trailing comma of "θ," is trimmed');
});

test('TC-T3: the geometry mirrors the stage: same padding and stroke as src/meet-stage.js draws', async () => {
  const stage = await readFile(`${ROOT}src/meet-stage.js`, 'utf8');
  const draw = stage.slice(stage.indexOf('function drawHighlight'), stage.indexOf('function wrap'));
  assert.equal(Number(/const pad = (\d+)/.exec(draw)[1]), DRAW_PAD_PX, 'pad matches');
  assert.equal(Number(/lineWidth = (\d+)/.exec(draw)[1]), STROKE_PX, 'stroke matches');
  assert.match(stage, /highlight: view\?\.highlight \? cleanHighlight\(view\.highlight\)/, 'the stage keeps a highlight small');
  const server = await readFile(`${ROOT}src/server.mjs`, 'utf8');
  assert.match(server, /out\.highlight = cleanHighlight\(view\.highlight\)/, 'and so does the server');
});
