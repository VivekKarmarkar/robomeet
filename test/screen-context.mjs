// P4 (docs/problems/presenting-v1.md, TC-P4): the robot gets the full visible text of the view on screen, line by
// line, on every move.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { viewText, watchScreen } from '../src/screen-context.mjs';
import { Store } from '../src/store.mjs';

const deck = JSON.parse(await readFile(new URL('../public/slides/projectile-motion-deck/deck.json', import.meta.url), 'utf8'));
// As the server stores it (cleanViews): line texts only.
const slides = deck.slides.map(slide => ({ title: slide.title, body: slide.body, views: slide.views.map(view => ({ x: view.x, y: view.y, w: view.w, h: view.h, lines: view.lines.map(line => line.text) })) }));

test('TC-P4: part 1 of the projectile PDF gives all three blue-box lines with their labels, in order', () => {
  const text = viewText({ title: 'Projectile motion', slides, slideIndex: 0, viewIndex: 0 }).normalize('NFC');
  assert.match(text, /^On your shared screen now: Projectile motion, page 1, part 1 of 3\./);
  const order = ['Horizontal:', 'Vertical:', 'Initial conditions:', 'm ẍ = 0', '(1)', 'm ÿ = −mg', '(2)', 'x(0) = 0, y(0) = 0,', 'ẋ(0) = v 0 cos θ, ẏ(0) = v 0 sin θ', '(3)'].map(item => text.indexOf(item));
  assert.ok(order.every(index => index > 0), `every line is present: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in page order');
  assert.ok(text.length > 1000, 'not a 350-character clip');
});

test('TC-P4: text slides and parts without text say so', () => {
  assert.match(viewText({ title: 'T', slides: [{ title: 'Agenda', body: 'One. Two.' }], slideIndex: 0 }), /page 1\. It shows: Agenda\. One\. Two\./);
  assert.match(viewText({ title: 'T', slides: [{ title: '', body: 'image:/slides/x.png', views: [{ x: 0, y: 0, w: 1, h: 1 }] }], slideIndex: 0 }), /has no text for this part/);
  assert.equal(viewText({ slides: [] }), null);
});

test('TC-P4: every manual move sends the new view text once, only while sharing with a live voice and no running walk', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'robomeet-screen-'));
  const store = new Store(directory);
  const sent = [];
  const live = { active: true, activeSession() { return this.active ? { id: 's' } : null; }, context: text => { sent.push(text); return true; } };
  const stop = watchScreen({ store, live, debounceMs: 10 });
  t.after(async () => { stop(); await rm(directory, { recursive: true, force: true }); });
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  store.update({ title: 'Projectile motion', slides, slideIndex: 0, viewIndex: 0, meeting: { status: 'joined', sharing: true } });
  await wait(40);
  assert.equal(sent.length, 1);
  store.update({ viewIndex: 1 }); store.update({ viewIndex: 2 });
  await wait(40);
  assert.equal(sent.length, 2, 'debounced to the final position');
  assert.match(sent[1], /part 3 of 3/);
  store.update({ meeting: { status: 'joined', sharing: true } });
  await wait(40);
  assert.equal(sent.length, 2, 'nothing new when the position did not change');
  store.update({ presenter: { status: 'running' }, viewIndex: 0 });
  await wait(40);
  assert.equal(sent.length, 2, 'the presenter sends its own');
  store.update({ presenter: { status: 'done' }, meeting: { status: 'joined', sharing: false }, viewIndex: 1 });
  await wait(40);
  assert.equal(sent.length, 2, 'not while the screen is not shared');
});
