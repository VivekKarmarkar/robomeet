import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPdfDeck, highlightFor, parseBboxLayout, planViews } from '../src/deck-builder.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'bin', 'deck.mjs');
const projectile = join(root, 'docs', 'projectile-motion', 'projectile_motion.pdf');
const LETTER = 792 / 612; // height / width
const FIT_H = (9 / 16) / LETTER; // page fraction a fit-width 16:9 view covers
const near = (actual, expected, epsilon = 1e-6) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
const pngSize = bytes => {
  assert.equal(bytes.toString('latin1', 1, 4), 'PNG');
  assert.equal(bytes.toString('latin1', 12, 16), 'IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};
// Vertically overlapping lines form one row; a view top strictly inside a row cuts text.
const rowsOf = lines => {
  const rows = [];
  for (const line of [...lines].sort((a, b) => a.y0 - b.y0)) {
    const last = rows.at(-1);
    if (last && line.y0 < last.y1) last.y1 = Math.max(last.y1, line.y1); else rows.push({ y0: line.y0, y1: line.y1 });
  }
  return rows;
};
const cuts = (y, rows) => rows.some(row => y > row.y0 + 1e-9 && y < row.y1 - 1e-9);
const line = (y0, y1, text = 'A line of ordinary body text on the page.') => ({ x0: 0.1, x1: 0.9, y0, y1, text });

// Minimal PDF writer for fixtures: pages [{ w, h, rotate?, text: [{ x, y, size, s }] }] in points (y from the top),
// Helvetica, optional Info Title.
function tinyPdf(pages, { title } = {}) {
  const objects = [];
  const add = body => objects.push(body);
  const esc = text => text.replace(/[\\()]/g, match => `\\${match}`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pagesId = 2 + pages.length * 2;
  const kids = [];
  for (const page of pages) {
    const stream = page.text.map(item => `BT /F1 ${item.size} Tf ${item.x} ${page.h - item.y} Td (${esc(item.s)}) Tj ET`).join('\n');
    add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${page.w} ${page.h}] ${page.rotate ? `/Rotate ${page.rotate} ` : ''}/Resources << /Font << /F1 1 0 R >> >> /Contents ${objects.length} 0 R >>`);
    kids.push(`${objects.length} 0 R`);
  }
  add(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`);
  add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const catalog = objects.length;
  if (title) add(`<< /Title (${esc(title)}) >>`);
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, index) => { const offset = out.length; out += `${index + 1} 0 obj\n${body}\nendobj\n`; return offset; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${title ? ` /Info ${objects.length} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('parseBboxLayout reads pages, blocks, lines and words from pdftotext -bbox-layout XHTML', () => {
  const pages = parseBboxLayout(`<doc>
  <page width="612.000000" height="792.000000">
    <flow>
      <block xMin="72.0" yMin="100.0" xMax="300.5" yMax="130.0">
        <line xMin="72.0" yMin="100.0" xMax="300.5" yMax="112.0">
          <word xMin="72.0" yMin="100.0" xMax="80.0" yMax="112.0">A</word>
          <word xMin="84.0" yMin="100.0" xMax="90.0" yMax="112.0">&amp;</word>
          <word xMin="94.0" yMin="100.0" xMax="120.0" yMax="112.0">B&lt;C</word>
        </line>
        <line xMin="72.0" yMin="118.0" xMax="200.0" yMax="130.0"><word xMin="72.0" yMin="118.0" xMax="200.0" yMax="130.0">second</word></line>
      </block>
    </flow>
  </page>
  <page width="960.000000" height="540.000000">
  </page>
</doc>`);
  assert.equal(pages.length, 2);
  assert.deepEqual({ width: pages[0].width, height: pages[0].height }, { width: 612, height: 792 });
  assert.equal(pages[0].blocks.length, 1);
  const [block] = pages[0].blocks;
  assert.deepEqual([block.x0, block.y0, block.x1, block.y1], [72, 100, 300.5, 130]);
  assert.deepEqual(block.lines.map(item => item.text), ['A & B<C', 'second']);
  assert.deepEqual([block.lines[1].x0, block.lines[1].y0, block.lines[1].x1, block.lines[1].y1], [72, 118, 200, 130]);
  assert.deepEqual(pages[1], { width: 960, height: 540, blocks: [] }); // an empty page keeps its place
});

test('planViews: a letter page gets fit-width views that start between rows and show every line whole', () => {
  const lines = Array.from({ length: 45 }, (_, index) => line(0.08 + index * 0.019, 0.092 + index * 0.019));
  const views = planViews({ pageAspect: LETTER, lines });
  assert.equal(views.length, 3);
  const rows = rowsOf(lines);
  for (const view of views) {
    assert.deepEqual([view.x, view.w], [0, 1]);
    near(view.h, FIT_H);
    assert.ok(view.y >= 0 && view.y + view.h <= 1 + 1e-9);
    assert.ok(!cuts(view.y, rows), `view top ${view.y} cuts a row`);
  }
  near(views[0].y, 0.08 - 0.025);
  for (let index = 1; index < views.length; index++) assert.ok(views[index].y > views[index - 1].y && views[index].y < views[index - 1].y + FIT_H, 'views step down and overlap');
  for (const item of lines) assert.ok(views.some(view => view.y <= item.y0 && item.y1 <= view.y + view.h), `line at ${item.y0} is never fully visible`);
});

test('planViews: a page at least as wide as 16:9 is one full view', () => {
  const lines = [line(0.1, 0.2), line(0.8, 0.9)];
  assert.deepEqual(planViews({ pageAspect: 400 / 1000, lines }), [{ x: 0, y: 0, w: 1, h: 1 }]);
  assert.deepEqual(planViews({ pageAspect: 9 / 16, lines }), [{ x: 0, y: 0, w: 1, h: 1 }]);
});

test('planViews: an empty page (or one holding only its page number) is one view of the whole page', () => {
  assert.deepEqual(planViews({ pageAspect: LETTER, lines: [] }), [{ x: 0, y: 0, w: 1, h: 1 }]);
  assert.deepEqual(planViews({ pageAspect: LETTER, lines: [line(0.95, 0.962, '7')] }), [{ x: 0, y: 0, w: 1, h: 1 }]);
});

test('planViews: a page-number footer does not add a window, real text at the bottom does', () => {
  const content = [line(0.1, 0.115), line(0.2, 0.215), line(0.3, 0.315)];
  for (const folio of ['12', '- 12 -', 'Page 12', 'Page 12 of 30', '12 / 30']) {
    const views = planViews({ pageAspect: LETTER, lines: [...content, line(0.95, 0.962, folio)] });
    assert.equal(views.length, 1, folio);
    assert.ok(views[0].y <= 0.1 && views[0].y + views[0].h >= 0.315, 'the one view shows the content');
    assert.ok(views[0].y + views[0].h < 0.95, 'and is centred on it, not stretched to the footer');
  }
  const views = planViews({ pageAspect: LETTER, lines: [...content, line(0.95, 0.962, 'A closing sentence at the very bottom.')] });
  assert.ok(views.length >= 2);
  assert.ok(views.at(-1).y + views.at(-1).h >= 0.962);
});

test('planViews: an equation and its number overlap vertically and are never split by a view top', () => {
  const equation = line(0.42, 0.47, 'y(x) = x tan θ − g x 2 / 2v 0 2 cos 2 θ');
  const number = { x0: 0.9, x1: 0.95, y0: 0.44, y1: 0.45, text: '(6)' };
  const lines = [line(0.1, 0.115), line(0.2, 0.215), line(0.3, 0.315), equation, number, line(0.6, 0.615), line(0.8, 0.815)];
  const views = planViews({ pageAspect: LETTER, lines });
  assert.ok(views.length >= 2);
  // Treated as separate rows, the gap between the number's bottom and the equation's bottom (0.455) would be picked.
  for (const view of views) assert.ok(!(view.y > equation.y0 && view.y < equation.y1), `view top ${view.y} cuts the equation`);
  assert.ok(!cuts(views[1].y, rowsOf(lines)));
  assert.ok(views.some(view => view.y <= equation.y0 && equation.y1 <= view.y + view.h), 'the equation is fully visible in a view');
});

test('highlightFor finds a phrase across consecutive lines and returns their padded union', () => {
  const view = { x: 0, y: 0.3, w: 1, h: 0.4, lines: [
    { text: 'Top line of the view', x: 0, y: 0.3, w: 0.2, h: 0.01 },
    { text: 'The two directions are uncoupled: gravity', x: 0.1, y: 0.4, w: 0.5, h: 0.012 },
    { text: 'touches only y. Each equation integrates', x: 0.1, y: 0.415, w: 0.45, h: 0.012 },
    { text: 'on its own.', x: 0.1, y: 0.43, w: 0.1, h: 0.012 },
    { text: 'x(t) = v 0 cos θ t', x: 0.5, y: 0.5, w: 0.2, h: 0.015 },
  ] };
  const box = highlightFor(view, '  GRAVITY \n touches   only ');
  near(box.x, 0.096, 1e-4); near(box.y, 0.396, 1e-4); near(box.w, 0.508, 1e-4); near(box.h, 0.035, 1e-4);
  const single = highlightFor(view, 'each equation');
  near(single.y, 0.411, 1e-4); near(single.h, 0.02, 1e-4); near(single.w, 0.458, 1e-4);
  const math = highlightFor(view, 'v0 cos θ'); // pdftotext splits subscripts: matched ignoring spaces
  near(math.x, 0.496, 1e-4); near(math.y, 0.496, 1e-4);
  const edge = highlightFor(view, 'top line'); // padding stops at the page and at the view's top edge
  assert.equal(edge.x, 0); assert.equal(edge.y, 0.3);
  assert.equal(highlightFor(view, 'not on this view'), null);
  assert.equal(highlightFor(view, '   '), null);
  assert.equal(highlightFor({ ...view, lines: view.lines.map(item => item.text) }, 'gravity'), null); // old decks: strings
});

test('bin/deck.mjs build, check and sheet on the projectile PDF', { timeout: 180_000 }, async t => {
  const slidesRoot = await mkdtemp(join(tmpdir(), 'robomeet-deck-'));
  t.after(() => rm(slidesRoot, { recursive: true, force: true }));
  const built = JSON.parse((await run(process.execPath, [cli, 'build', projectile, '--slug', 'pm-test', '--slides-root', slidesRoot], { cwd: root })).stdout);
  const deckFile = join(slidesRoot, 'pm-test', 'deck.json');
  // No Title in the PDF's metadata, so the title falls back to the slug.
  assert.deepEqual(built, { slug: 'pm-test', title: 'pm-test', pages: 1, viewsPerPage: [3], deck: deckFile });
  const deck = JSON.parse(await readFile(deckFile, 'utf8'));
  const views = deck.slides[0].views;
  assert.equal(views.length, 3);
  // Exact renders are 1920x1080, and no view's top edge cuts a text row of the page.
  const layout = parseBboxLayout((await run('pdftotext', ['-bbox-layout', projectile, '-'])).stdout)[0];
  const rows = rowsOf(layout.blocks.flatMap(block => block.lines).map(item => ({ y0: item.y0 / layout.height, y1: item.y1 / layout.height })));
  for (const view of views) {
    assert.match(view.asset, /^\/slides\/pm-test\/page-1-view-\d\.png$/);
    assert.deepEqual(pngSize(await readFile(join(slidesRoot, view.asset.replace(/^\/slides\//, '')))), { width: 1920, height: 1080 });
    assert.ok(!cuts(view.y, rows), `view top ${view.y} cuts a text row`);
    assert.ok(view.lines.length > 0);
    for (const item of view.lines) {
      assert.equal(typeof item.text, 'string');
      for (const key of ['x', 'y', 'w', 'h']) assert.ok(Number.isFinite(item[key]) && item[key] >= 0 && item[key] <= 1, `${key} ${item[key]}`);
    }
    for (const block of view.blocks) assert.deepEqual(Object.keys(block).sort(), ['h', 'text', 'w', 'x', 'y']);
  }
  assert.ok(views[0].lines.some(item => item.text === 'Projectile Motion'));

  // Narration as a coding agent would write it: a short beat with a highlight, an over-long beat, one view left out.
  views[0].say = 'The setup: a point mass is launched from the origin with speed v zero at angle theta above the horizontal; gravity acts downward, air resistance is neglected.';
  views[0].highlight = highlightFor(views[0], 'Governing equations');
  assert.ok(views[0].highlight);
  views[1].say = `${'Three results follow from the trajectory. '.repeat(11)}`.trim();
  views[1].highlight = 'Three results';
  views[2].highlight = { x: 0.1, y: 0.05, w: 0.3, h: 0.05 }; // above this view: not visible
  await writeFile(deckFile, JSON.stringify(deck, null, 2));

  const report = JSON.parse((await run(process.execPath, [cli, 'check', 'pm-test', '--slides-root', slidesRoot], { cwd: root })).stdout);
  assert.equal(report.views.length, 3);
  const [first, second, third] = report.views;
  assert.deepEqual([first.page, first.part, first.parts, first.hasSay, first.flag], [1, 1, 3, true, null]);
  assert.equal(first.sayLength, views[0].say.length);
  assert.ok(first.coverage >= 0.7, `coverage ${first.coverage}`);
  assert.equal(first.highlight.inside, true);
  assert.ok(second.sayLength > 450);
  assert.equal(second.flag, 'split this beat');
  assert.equal(second.highlight.inside, true); // the phrase resolved against the view's lines
  assert.deepEqual([third.hasSay, third.coverage, third.highlight.inside], [false, null, false]);
  assert.ok(report.warnings.some(text => /page 1 part 2\/3: .*split this beat/.test(text)));
  assert.ok(report.warnings.some(text => /page 1 part 3\/3: highlight is not inside the view/.test(text)));
  assert.ok(report.warnings.some(text => /page 1 part 3\/3: no narration/.test(text)));
  assert.ok(!report.warnings.some(text => text.startsWith('page 1 part 1/3')));

  const listed = (await run(process.execPath, [cli, 'sheet', 'pm-test', '--slides-root', slidesRoot], { cwd: root })).stdout.trim().split('\n');
  assert.deepEqual(listed, [join(slidesRoot, 'pm-test', 'sheet-1.png')]); // 3 views: one 2x2 sheet
  const size = pngSize(await readFile(listed[0]));
  assert.equal(size.width, 24 * 3 + 960 * 2);
  assert.ok(size.height > 2 * 540 + 2 * 60, `sheet height ${size.height}`);

  await assert.rejects(run(process.execPath, [cli, 'check', '../pm-test', '--slides-root', slidesRoot], { cwd: root }), /Not a deck slug/);
});

test('buildPdfDeck: metadata title, maxPages, empty, 16:9, wide, rotated and footer pages', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'robomeet-deck-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pdf = join(directory, 'synthetic.pdf');
  const body = Array.from({ length: 40 }, (_, index) => ({ x: 72, y: 80 + index * 16, size: 11, s: `Line ${index + 1} of the synthetic body text for testing.` }));
  await writeFile(pdf, tinyPdf([
    { w: 612, h: 792, text: body },
    { w: 612, h: 792, text: [] },
    { w: 960, h: 540, text: [{ x: 60, y: 80, size: 32, s: 'An exactly 16:9 slide' }] },
    { w: 1000, h: 400, text: [{ x: 60, y: 80, size: 32, s: 'Wider than 16:9' }] },
    { w: 612, h: 792, rotate: 90, text: [{ x: 72, y: 100, size: 20, s: 'A rotated (landscape) page' }] },
    { w: 612, h: 792, text: [{ x: 72, y: 100, size: 14, s: 'A short page' }, { x: 280, y: 760, size: 10, s: 'Page 6 of 7' }] },
    { w: 612, h: 792, text: [{ x: 72, y: 100, size: 14, s: 'Past maxPages' }] },
  ], { title: 'Synthetic Test Deck' }));
  const slidesRoot = join(directory, 'slides');
  const deck = await buildPdfDeck(pdf, { slidesRoot, maxPages: 6 });
  assert.equal(deck.title, 'Synthetic Test Deck');
  assert.equal(deck.slug, 'synthetic');
  assert.equal(deck.pages, 6);
  assert.equal(deck.slides.length, 6);
  const counts = deck.slides.map(slide => slide.views.length);
  assert.ok(counts[0] >= 2, `a full letter page scrolls: ${counts[0]} views`);
  assert.deepEqual(counts.slice(1), [1, 1, 1, 1, 1]);
  for (const index of [1, 2, 3]) { const { x, y, w, h } = deck.slides[index].views[0]; assert.deepEqual({ x, y, w, h }, { x: 0, y: 0, w: 1, h: 1 }); }
  const render = async view => pngSize(await readFile(join(slidesRoot, view.asset.replace(/^\/slides\//, ''))));
  for (const view of deck.slides[0].views) assert.deepEqual(await render(view), { width: 1920, height: 1080 });
  const empty = await render(deck.slides[1].views[0]); // whole portrait page, as large as fits the stage
  assert.equal(empty.height, 1080);
  assert.ok(empty.width === 834 || empty.width === 835, `width ${empty.width}`);
  assert.deepEqual(await render(deck.slides[2].views[0]), { width: 1920, height: 1080 });
  assert.deepEqual(await render(deck.slides[3].views[0]), { width: 1920, height: 768 });
  // /Rotate 90: the page is displayed landscape; its text boxes must stay inside the page.
  const rotated = deck.slides[4];
  assert.deepEqual([rotated.pageWidth, rotated.pageHeight], [792, 612]);
  assert.deepEqual(pngSize(await readFile(join(slidesRoot, 'synthetic', 'page-5.png'))).width, 2400);
  assert.deepEqual(await render(rotated.views[0]), { width: 1920, height: 1080 });
  const rotatedLines = rotated.views[0].lines;
  assert.ok(rotatedLines.length > 0);
  for (const item of rotatedLines) assert.ok(item.x >= 0 && item.x + item.w <= 1.0001 && item.y >= 0 && item.y + item.h <= 1.0001, JSON.stringify(item));
  assert.deepEqual(await render(deck.slides[5].views[0]), { width: 1920, height: 1080 });

  const given = await buildPdfDeck(pdf, { slidesRoot, slug: 'given', title: 'Given title', maxPages: 1, exactViews: false });
  assert.equal(given.title, 'Given title');
  assert.equal(given.pages, 1);
  assert.equal(given.slides[0].views[0].asset, undefined);
  await assert.rejects(buildPdfDeck(pdf, { slidesRoot, slug: '..' }), /Unsafe deck slug/);
});
