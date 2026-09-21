import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { crc32 } from 'node:zlib';
import { extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { DECK_SLUG, buildDeck, deckSlug, isLocalAddress, planUniformViews, slugForInput, webRequestAllowed } from '../src/deck-formats.mjs';
import { parseBboxLayout } from '../src/deck-builder.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'bin', 'deck.mjs');
const projectile = join(root, 'docs', 'projectile-motion', 'projectile_motion.pdf');
const WHOLE = { x: 0, y: 0, w: 1, h: 1 };
const near = (actual, expected, epsilon = 1e-6) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
const rectOf = ({ x, y, w, h }) => ({ x, y, w, h });
const pngSize = bytes => {
  assert.equal(bytes.toString('latin1', 1, 4), 'PNG');
  assert.equal(bytes.toString('latin1', 12, 16), 'IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};
const fileOf = (slidesRoot, asset) => join(slidesRoot, asset.replace(/^\/slides\//, ''));
const sizeOf = async (slidesRoot, asset) => pngSize(await readFile(fileOf(slidesRoot, asset)));
const ffmpeg = args => run('ffmpeg', ['-v', 'error', '-y', ...args]);
// Decoded RGB bytes of a picture after an ffmpeg filter (crop=... picks the pixels).
const rgb = async (file, filter) => (await run('ffmpeg', ['-v', 'error', '-i', file, '-vf', `${filter},format=rgb24`, '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 64 << 20 })).stdout;
const tempDir = async t => {
  const dir = await mkdtemp(join(tmpdir(), 'robomeet-formats-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
// Vertically overlapping lines form one row; a view top strictly inside a row cuts text.
const rowsOf = lines => {
  const rows = [];
  for (const line of [...lines].sort((a, b) => a.y - b.y)) {
    const last = rows.at(-1);
    if (last && line.y < last.y1) last.y1 = Math.max(last.y1, line.y + line.h); else rows.push({ y0: line.y, y1: line.y + line.h });
  }
  return rows;
};
const cuts = (y, rows) => rows.some(row => y > row.y0 + 1e-9 && y < row.y1 - 1e-9);

// A long page: a title, 6 sections of 2 paragraphs; optionally two pictures at the top, one beside the page (allowed)
// and one outside its folder (must be refused).
function htmlPage(title, { pictures = false } = {}) {
  const sections = Array.from({ length: 6 }, (_, s) => `<h2>Section ${s + 1}: how the stage scrolls</h2>${Array.from({ length: 2 }, (_, p) =>
    `<p>${Array.from({ length: 8 }, (_, k) => `Sentence ${k + 1} of paragraph ${p + 1} in section ${s + 1} explains how a long web page becomes windows on the stage.`).join(' ')}</p>`).join('')}`).join('\n');
  const images = pictures ? '<div style="position:relative;height:120px"><img src="assets/green.png" width="200" height="100" style="position:absolute;left:700px;top:10px"><img src="../red.png" width="200" height="100" style="position:absolute;left:920px;top:10px"></div>' : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{margin:0;padding:40px 80px;background:#fff;color:#111;font:20px/1.6 "DejaVu Sans",sans-serif}h1{font-size:44px;margin:0 0 24px}h2{font-size:30px;margin:36px 0 12px}p{margin:0 0 18px}</style></head><body>${images}<h1>${title}</h1>\n${sections}</body></html>`;
}

// Minimal flat ODF presentation: two 16:9 slides of text.
const slideXml = (heading, points) => `<draw:page draw:master-page-name="Default">
   <draw:frame svg:x="2cm" svg:y="2cm" svg:width="24cm" svg:height="3cm"><draw:text-box><text:p><text:span text:style-name="T1">${heading}</text:span></text:p></draw:text-box></draw:frame>
   <draw:frame svg:x="2cm" svg:y="7cm" svg:width="24cm" svg:height="5cm"><draw:text-box>${points.map(point => `<text:p>${point}</text:p>`).join('')}</draw:text-box></draw:frame>
  </draw:page>`;
const FODP = `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.presentation">
 <office:automatic-styles>
  <style:page-layout style:name="PM1"><style:page-layout-properties fo:margin-top="0cm" fo:margin-bottom="0cm" fo:margin-left="0cm" fo:margin-right="0cm" fo:page-width="28cm" fo:page-height="15.75cm" style:print-orientation="landscape"/></style:page-layout>
  <style:style style:name="T1" style:family="text"><style:text-properties fo:font-size="36pt"/></style:style>
 </office:automatic-styles>
 <office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1"/></office:master-styles>
 <office:body><office:presentation>
  ${slideXml('First slide title', ['Alpha point on the first slide', 'Beta point on the first slide'])}
  ${slideXml('Second slide title', ['Gamma point on the second slide'])}
 </office:presentation></office:body>
</office:document>
`;
// A document of about two pages of text.
const RTF = `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\fswiss Liberation Sans;}}\\f0\\fs24
${Array.from({ length: 30 }, (_, index) => `\\pard\\sa180 Paragraph ${index + 1}: ${'The document path converts office text to PDF and reads it in fit-width windows. '.repeat(4)}\\par`).join('\n')}
}`;

test('planUniformViews: at least as wide as 16:9 is one view; taller steps down evenly with >= 10% overlap', () => {
  assert.deepEqual(planUniformViews({ pageAspect: 9 / 16 }), [WHOLE]);
  assert.deepEqual(planUniformViews({ pageAspect: 1 / 3 }), [WHOLE]);
  const h = (9 / 16) / (4000 / 1200);
  const views = planUniformViews({ pageAspect: 4000 / 1200 });
  assert.equal(views.length, 7); // ceil((1 - h) / 0.9h) + 1
  near(views[0].y, 0);
  near(views.at(-1).y + h, 1);
  for (const view of views) assert.deepEqual([view.x, view.w, view.h], [0, 1, h]);
  const steps = views.slice(1).map((view, index) => view.y - views[index].y);
  for (const step of steps) { near(step, steps[0]); assert.ok(step <= 0.9 * h + 1e-12, `step ${step} leaves less than 10% overlap`); }
  assert.equal(planUniformViews({ pageAspect: 3 / 4 }).length, 2);
});

test('slugForInput and the web request policy (file:// only inside the page folder)', async t => {
  assert.equal(slugForInput('https://Example.com/Docs/Intro.html?x=1#top'), 'example-com-docs-intro-html');
  assert.equal(slugForInput('http://127.0.0.1:8080/'), '127-0-0-1');
  assert.equal(slugForInput('/talks/My Talk v2.pptx'), 'my-talk-v2');
  assert.equal(slugForInput(pathToFileURL('/talks/notes.html').href), 'notes');
  const dir = await realpath(await tempDir(t));
  const site = join(dir, 'site');
  await mkdir(join(site, 'img'), { recursive: true });
  await writeFile(join(site, 'img', 'a.png'), '');
  await writeFile(join(dir, 'secret.txt'), 'secret');
  await symlink(join(dir, 'secret.txt'), join(site, 'link.txt'));
  const url = path => pathToFileURL(path).href;
  assert.equal(await webRequestAllowed('https://example.com/a.css', null), true);
  assert.equal(await webRequestAllowed('data:image/png;base64,AAAA', null), true);
  assert.equal(await webRequestAllowed(url(join(site, 'img', 'a.png')), site), true);
  assert.equal(await webRequestAllowed(url(join(dir, 'secret.txt')), site), false);
  assert.equal(await webRequestAllowed(`${url(site)}/../secret.txt`, site), false);
  assert.equal(await webRequestAllowed(url(join(site, 'link.txt')), site), false); // a symlink out of the folder
  assert.equal(await webRequestAllowed(url(join(site, 'img', 'a.png')), null), false); // a web URL gets no file:// at all
  assert.equal(await webRequestAllowed('ftp://example.com/x', site), false);
  assert.equal(await webRequestAllowed('chrome://settings', site), false);
});

test('buildDeck: a local HTML page becomes fit-width windows that start between text rows, as 1:1 1920x1080 crops', { timeout: 60_000 }, async t => {
  const dir = await tempDir(t);
  const site = join(dir, 'site');
  await mkdir(join(site, 'assets'), { recursive: true });
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x00ff00:size=200x100', '-frames:v', '1', join(site, 'assets', 'green.png')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xff0000:size=200x100', '-frames:v', '1', join(dir, 'red.png')]);
  await writeFile(join(site, 'formats-page.html'), htmlPage('Deck Formats Test Page', { pictures: true }));
  const slidesRoot = join(dir, 'slides');
  const deck = await buildDeck(join(site, 'formats-page.html'), { slidesRoot });
  assert.deepEqual([deck.slug, deck.title, deck.pages, deck.slides.length], ['formats-page', 'Deck Formats Test Page', 1, 1]);
  const [slide] = deck.slides;
  assert.equal(slide.body, 'image:/slides/formats-page/page-1.png');
  const picture = join(slidesRoot, 'formats-page', 'page-1.png');
  const page = pngSize(await readFile(picture));
  assert.equal(page.width, 1920); // 1280 CSS px at device scale 1.5
  assert.deepEqual([slide.pageWidth, slide.pageHeight], [page.width, page.height]);
  const { views } = slide;
  assert.ok(views.length >= 2, `${views.length} views`);
  assert.equal(views[0].y, 0); // a web page starts at its top (the pictures above the title are not cut off)
  const lines = [...new Map(views.flatMap(view => view.lines).map(line => [JSON.stringify(line), line])).values()];
  const rows = rowsOf(lines);
  assert.ok(rows.length > 50, `${rows.length} text rows`);
  for (const [index, view] of views.entries()) {
    assert.deepEqual([view.x, view.w], [0, 1]);
    near(view.h * page.height, 1080, 1e-6);
    assert.ok(!cuts(view.y, rows), `view ${index + 1} top ${view.y} cuts a text row`);
    const render = fileOf(slidesRoot, view.asset);
    assert.deepEqual(pngSize(await readFile(render)), { width: 1920, height: 1080 });
    // In pixels: a window that starts between rows has blank (white) top pixel rows across the whole width.
    const top = await rgb(render, 'crop=1920:2:0:0');
    assert.ok(top.every(value => value >= 250), `view ${index + 1}: its top pixel rows are not blank page`);
    if (index) assert.ok(view.y > views[index - 1].y && view.y < views[index - 1].y + view.h, 'windows step down and overlap');
  }
  for (const line of lines) assert.ok(views.some(view => view.y <= line.y + 1e-9 && line.y + line.h <= view.y + view.h + 1e-9), `"${line.text}" is never fully visible`);
  assert.ok(views[0].lines.some(line => line.text === 'Deck Formats Test Page'));
  assert.ok(views[0].blocks.some(block => block.text === 'Deck Formats Test Page'));
  assert.ok(lines.some(line => line.text.startsWith('Sentence 8 of paragraph 2 in section 6')));
  // The exact render is the page picture's own pixels (a 1:1 crop, no resampling).
  const second = views[1];
  const crop = await rgb(picture, `crop=1920:1080:0:${Math.round(second.y * page.height)}`);
  assert.ok(crop.equals(await rgb(fileOf(slidesRoot, second.asset), 'null')), 'view 2 is not a 1:1 crop of the page picture');
  // file:// policy: the picture in the page's folder loaded (green), the one outside it was refused (not red).
  const [inside, outside] = [await rgb(picture, 'crop=1:1:1320:150'), await rgb(picture, 'crop=1:1:1650:150')];
  assert.ok(inside[0] < 40 && inside[1] > 215 && inside[2] < 40, `inside picture pixel ${[...inside]}`);
  assert.ok(!(outside[0] > 200 && outside[1] < 80 && outside[2] < 80), `outside picture was loaded: ${[...outside]}`);
});

test('buildDeck: an http(s) URL (served locally) gets a hostname+path slug and its document title; HTTP errors refuse', { timeout: 60_000 }, async t => {
  const server = createServer((request, response) => {
    if (request.url === '/talk/notes.html') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(htmlPage('Served Notes')); return; }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('missing');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const slidesRoot = await tempDir(t);
  const deck = await buildDeck(`${base}/talk/notes.html`, { slidesRoot });
  assert.deepEqual([deck.slug, deck.title, deck.source], ['127-0-0-1-talk-notes-html', 'Served Notes', `${base}/talk/notes.html`]);
  const { views } = deck.slides[0];
  assert.ok(views.length >= 2, `${views.length} views`);
  const rows = rowsOf([...new Map(views.flatMap(view => view.lines).map(line => [JSON.stringify(line), line])).values()]);
  for (const view of views) {
    assert.deepEqual(await sizeOf(slidesRoot, view.asset), { width: 1920, height: 1080 });
    assert.ok(!cuts(view.y, rows), `view top ${view.y} cuts a text row`);
  }
  // A failed rebuild leaves the deck that is already there, and no staging folder.
  await assert.rejects(buildDeck(`${base}/missing.html`, { slidesRoot, slug: deck.slug }), /HTTP 404/);
  assert.equal(JSON.parse(await readFile(join(slidesRoot, deck.slug, 'deck.json'), 'utf8')).title, 'Served Notes');
  assert.deepEqual(await readdir(slidesRoot), [deck.slug]);
});

test('TC-P7b: a site that refuses automated browsers (HeadlessChrome agent, navigator.webdriver) still becomes a deck with its text', { timeout: 60_000 }, async t => {
  // Refuses like openai.com did (HTTP 403 for a headless agent), and hides its text from an automated page.
  const server = createServer((request, response) => {
    if (/HeadlessChrome/.test(request.headers['user-agent'] || '')) { response.writeHead(403, { 'content-type': 'text/plain' }); response.end('forbidden'); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>Guarded</title><body style="font:24px sans-serif"><h1 id="t">Guarded article</h1><p>Only for people.</p><script>if (navigator.webdriver) document.body.textContent = 'bot';</script></body>`);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const slidesRoot = await tempDir(t);
  const deck = await buildDeck(`http://127.0.0.1:${server.address().port}/article`, { slidesRoot });
  assert.equal(deck.title, 'Guarded');
  const text = deck.slides[0].views.flatMap(view => view.lines.map(line => line.text)).join(' ');
  assert.match(text, /Guarded article/);
  assert.match(text, /Only for people\./);
});

test('buildDeck: pictures — a tall one steps down in 1920x1080 crops, a wide one is one view, fit page is one view', { timeout: 60_000 }, async t => {
  const dir = await tempDir(t);
  const slidesRoot = join(dir, 'slides');
  const tall = join(dir, 'tall.png'), wide = join(dir, 'wide.png'), small = join(dir, 'small.jpg'), strip = join(dir, 'strip.webp');
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=1200x4000:rate=1', '-frames:v', '1', tall]);
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=2400x800:rate=1', '-frames:v', '1', wide]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:size=800x600', '-frames:v', '1', small]);
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=640x2000:rate=1', '-frames:v', '1', strip]);

  const tallDeck = await buildDeck(tall, { slidesRoot });
  assert.deepEqual([tallDeck.slug, tallDeck.title, tallDeck.pages, tallDeck.slides[0].body], ['tall', 'tall', 1, 'image:/slides/tall/page-1.png']);
  assert.deepEqual(pngSize(await readFile(join(slidesRoot, 'tall', 'page-1.png'))), { width: 1200, height: 4000 }); // the picture as it is
  const tallViews = tallDeck.slides[0].views;
  assert.deepEqual(tallViews.map(rectOf), planUniformViews({ pageAspect: 4000 / 1200 }));
  assert.equal(tallViews.length, 7);
  for (const view of tallViews) {
    assert.deepEqual(await sizeOf(slidesRoot, view.asset), { width: 1920, height: 1080 });
    assert.deepEqual([view.lines, view.blocks], [[], []]);
  }

  const stripDeck = await buildDeck(strip, { slidesRoot });
  assert.equal(stripDeck.slides[0].body, 'image:/slides/strip/page-1.webp');
  assert.equal(stripDeck.slides[0].views.length, planUniformViews({ pageAspect: 2000 / 640 }).length);
  for (const view of stripDeck.slides[0].views) assert.deepEqual(await sizeOf(slidesRoot, view.asset), { width: 1920, height: 1080 });

  const wideDeck = await buildDeck(wide, { slidesRoot });
  assert.equal(wideDeck.slides[0].views.length, 1);
  assert.deepEqual(rectOf(wideDeck.slides[0].views[0]), WHOLE);
  assert.deepEqual(await sizeOf(slidesRoot, wideDeck.slides[0].views[0].asset), { width: 1920, height: 640 }); // scaled to fit

  const tallPage = await buildDeck(tall, { slidesRoot, slug: 'tall-page', fit: 'page' });
  assert.equal(tallPage.slides[0].views.length, 1);
  assert.deepEqual(rectOf(tallPage.slides[0].views[0]), WHOLE);
  assert.deepEqual(await sizeOf(slidesRoot, tallPage.slides[0].views[0].asset), { width: 324, height: 1080 }); // as large as fits

  const smallWidth = await buildDeck(small, { slidesRoot }); // 4:3 is taller than 16:9: two fit-width windows
  assert.equal(smallWidth.slides[0].views.length, 2);
  for (const view of smallWidth.slides[0].views) assert.deepEqual(await sizeOf(slidesRoot, view.asset), { width: 1920, height: 1080 });
  const smallPage = await buildDeck(small, { slidesRoot, fit: 'page' });
  const [only] = smallPage.slides[0].views;
  assert.equal(smallPage.slides[0].views.length, 1);
  assert.equal(`image:${only.asset}`, smallPage.slides[0].body); // fits the stage as it is: the picture is the render
});

test('buildDeck: a PDF with fit page is one whole-page view per page, rendered as large as fits 1920x1080', { timeout: 60_000 }, async t => {
  const slidesRoot = await tempDir(t);
  const deck = await buildDeck(projectile, { slidesRoot, slug: 'pm-page', fit: 'page' });
  assert.deepEqual([deck.pages, deck.slides.length, deck.slides[0].views.length], [1, 1, 1]);
  const [view] = deck.slides[0].views;
  assert.deepEqual(rectOf(view), WHOLE);
  assert.equal(view.asset, '/slides/pm-page/page-1-view-1.png');
  const size = await sizeOf(slidesRoot, view.asset);
  assert.equal(size.height, 1080);
  assert.ok(size.width === 834 || size.width === 835, `width ${size.width}`); // US Letter, portrait
  const layout = parseBboxLayout((await run('pdftotext', ['-bbox-layout', projectile, '-'])).stdout)[0];
  assert.equal(view.lines.length, layout.blocks.flatMap(block => block.lines).length); // every line of the page
  assert.equal(view.blocks.length, layout.blocks.length);
  assert.ok(view.lines.some(line => line.text === 'Projectile Motion'));
  const saved = JSON.parse(await readFile(join(slidesRoot, 'pm-page', 'deck.json'), 'utf8'));
  assert.deepEqual(saved.slides[0].views.map(rectOf), [WHOLE]);
  const widthDeck = await buildDeck(projectile, { slidesRoot, slug: 'pm-width' }); // default: fit-width windows
  assert.equal(widthDeck.slides[0].views.length, 3);
});

test('buildDeck: office files via LibreOffice — .pptx slides are one whole view each, an .rtf document reads in fit-width windows', { timeout: 120_000 }, async t => {
  const dir = await tempDir(t);
  const fodp = join(dir, 'two-slides.fodp');
  const pptx = join(dir, 'two-slides.pptx');
  await writeFile(fodp, FODP);
  try {
    await run('soffice', [`-env:UserInstallation=${pathToFileURL(join(dir, 'lo-profile')).href}`, '--headless', '--convert-to', 'pptx', '--outdir', dir, fodp], { timeout: 90_000 });
    await stat(pptx);
  } catch (error) {
    t.skip(`soffice could not make the .pptx fixture in this environment: ${String(error.message).split('\n')[0]}`);
    return;
  }
  // The conversion's temporary folder (PDF + LibreOffice profile) lives in os.tmpdir(): point it at a private folder.
  const privateTmp = join(dir, 'tmp');
  await mkdir(privateTmp);
  const savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = privateTmp;
  t.after(() => { if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp; });
  const slidesRoot = join(dir, 'slides');
  const deck = await buildDeck(pptx, { slidesRoot }); // presentations default to fit 'page'
  assert.deepEqual([deck.slug, deck.source, deck.pages], ['two-slides', pptx, 2]);
  assert.deepEqual(deck.slides.map(slide => slide.views.length), [1, 1]);
  for (const slide of deck.slides) {
    assert.deepEqual(rectOf(slide.views[0]), WHOLE);
    assert.deepEqual(await sizeOf(slidesRoot, slide.views[0].asset), { width: 1920, height: 1080 });
  }
  assert.deepEqual(deck.slides[0].views[0].lines.map(line => line.text), ['First slide title', 'Alpha point on the first slide', 'Beta point on the first slide']);
  assert.ok(deck.slides[1].views[0].lines.some(line => line.text === 'Gamma point on the second slide'));
  const saved = JSON.parse(await readFile(join(slidesRoot, 'two-slides', 'deck.json'), 'utf8'));
  assert.equal(saved.source, pptx); // the original file, not the temporary PDF
  assert.deepEqual(saved.slides.map(slide => slide.views.length), [1, 1]);

  const rtf = join(dir, 'long-notes.rtf');
  await writeFile(rtf, RTF);
  const doc = await buildDeck(rtf, { slidesRoot }); // documents default to fit 'width'
  assert.equal(doc.slug, 'long-notes');
  assert.ok(doc.pages >= 2, `${doc.pages} pages`);
  assert.ok(doc.slides[0].views.length >= 2, `page 1 has ${doc.slides[0].views.length} views`);
  for (const slide of doc.slides) for (const view of slide.views) assert.deepEqual(await sizeOf(slidesRoot, view.asset), { width: 1920, height: 1080 });
  assert.ok(doc.slides[0].views[0].lines.some(line => line.text.startsWith('Paragraph 1:')));
  assert.deepEqual((await readdir(privateTmp)).filter(name => name.startsWith('robomeet-')), []); // temporary PDF and profile removed
  assert.deepEqual((await readdir(slidesRoot)).sort(), ['long-notes', 'two-slides']); // no staging folder left behind
});

test('buildDeck refuses unsupported or unsafe inputs before touching any deck directory', { timeout: 30_000 }, async t => {
  const dir = await tempDir(t);
  const slidesRoot = join(dir, 'slides');
  await mkdir(join(slidesRoot, 'keep'), { recursive: true });
  await writeFile(join(slidesRoot, 'keep', 'deck.json'), '{}');
  const key = join(dir, 'talk.key');
  const txt = join(dir, 'notes.txt');
  const png = join(dir, 'pic.png');
  await writeFile(key, 'not a real keynote file');
  await writeFile(txt, 'plain text');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=gray:size=320x180', '-frames:v', '1', png]);
  await assert.rejects(buildDeck(key, { slidesRoot }), /Keynote \(\.key\) files are not supported/);
  await assert.rejects(buildDeck(txt, { slidesRoot }), /Unsupported input notes\.txt/);
  await assert.rejects(buildDeck('ftp://example.com/deck.pdf', { slidesRoot }), /Refusing ftp: input/);
  await assert.rejects(buildDeck('javascript:alert(1)', { slidesRoot }), /Refusing javascript: input/);
  await assert.rejects(buildDeck(join(dir, 'missing.pdf'), { slidesRoot }), /No such file/);
  await writeFile(join(dir, 'fake.png'), 'not a picture');
  await assert.rejects(buildDeck(join(dir, 'fake.png'), { slidesRoot }), /Not a readable picture: fake\.png/);
  await assert.rejects(buildDeck(png, { slidesRoot, slug: '..' }), /Unsafe deck slug/);
  await assert.rejects(buildDeck(png, { slidesRoot, slug: 'keep/../..' }), /Unsafe deck slug/);
  await assert.rejects(buildDeck(png, { slidesRoot, fit: 'zoom' }), /fit must be 'page' or 'width'/);
  await assert.rejects(buildDeck(png, {}), /slidesRoot is required/);
  assert.equal(await readFile(join(slidesRoot, 'keep', 'deck.json'), 'utf8'), '{}'); // nothing was wiped
  const fromUrl = await buildDeck(pathToFileURL(png).href, { slidesRoot }); // a file:// URL names a local file
  assert.deepEqual([fromUrl.slug, fromUrl.slides[0].views.length, fromUrl.slides[0].views[0].asset], ['pic', 1, '/slides/pic/page-1.png']);
});

test('bin/deck.mjs build takes pictures and --fit page|width', { timeout: 60_000 }, async t => {
  const dir = await tempDir(t);
  const strip = join(dir, 'strip.png');
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=900x3000:rate=1', '-frames:v', '1', strip]);
  const build = (...args) => run(process.execPath, [cli, 'build', strip, '--slides-root', dir, ...args], { cwd: root }).then(({ stdout }) => JSON.parse(stdout));
  assert.deepEqual(await build('--fit', 'page'), { slug: 'strip', title: 'strip', pages: 1, viewsPerPage: [1], deck: join(dir, 'strip', 'deck.json') });
  const width = await build('--slug', 'Strip Width', '--title', 'A strip');
  assert.deepEqual(width, { slug: 'strip-width', title: 'A strip', pages: 1, viewsPerPage: [planUniformViews({ pageAspect: 3000 / 900 }).length], deck: join(dir, 'strip-width', 'deck.json') });
  await assert.rejects(build('--fit', 'zoom'), /Usage/);
});

// Chrome processes started by this test process (Playwright launches Chrome as a direct child), as command lines.
const chromeChildren = () => run('ps', ['--ppid', String(process.pid), '-o', 'args=']).then(({ stdout }) => stdout.split('\n').filter(line => /chrome/i.test(line)), () => []);
// Chrome children still running after `ms`: browser.close() returns once the connection drops, and the process exits a
// moment later.
async function chromeLeftAfter(ms) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(done => setTimeout(done, 100))) if (!(await chromeChildren()).length) return [];
  return chromeChildren();
}
// A server whose page starts but never ends: DOMContentLoaded never comes.
async function neverEnding(t) {
  const server = createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.write('<!doctype html><title>Slow</title><h1>Loading forever'); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/slow`;
}

test('buildDeck: a web page that never finishes is given up on (a script that never yields fails its step, a load that never ends meets the deadline); the browser is closed and nothing is left', { timeout: 90_000 }, async t => {
  const dir = await tempDir(t);
  const slidesRoot = join(dir, 'slides');
  await writeFile(join(dir, 'busy.html'), '<!doctype html><title>Busy</title><h1>A page whose script never yields</h1><script>addEventListener("load", () => setTimeout(() => { for (;;) {} }, 200))</script>');
  let started = Date.now();
  await assert.rejects(buildDeck(join(dir, 'busy.html'), { slidesRoot }), /stopped responding/);
  assert.ok(Date.now() - started < 40_000, `took ${Date.now() - started} ms`);
  const slow = await neverEnding(t);
  started = Date.now();
  await assert.rejects(buildDeck(slow, { slidesRoot, deadlineMs: 4_000 }), /Gave up on .* after 4 s/);
  assert.ok(Date.now() - started < 12_000, `took ${Date.now() - started} ms`);
  assert.deepEqual(await readdir(slidesRoot), []); // no staging folder left
  assert.deepEqual(await chromeLeftAfter(5_000), []); // the browser was closed
});

test('buildDeck: an AbortSignal cancels a build (the browser is closed) and a cancelled build changes no deck', { timeout: 60_000 }, async t => {
  const dir = await tempDir(t);
  const slidesRoot = join(dir, 'slides');
  const png = join(dir, 'pic.png');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=gray:size=320x180', '-frames:v', '1', png]);
  await assert.rejects(buildDeck(png, { slidesRoot, signal: AbortSignal.abort() }), /cancelled/);
  const controller = new AbortController();
  const slow = await neverEnding(t);
  setTimeout(() => controller.abort(), 1_500);
  const started = Date.now();
  await assert.rejects(buildDeck(slow, { slidesRoot, signal: controller.signal }), /cancelled/);
  assert.ok(Date.now() - started < 8_000, `took ${Date.now() - started} ms`);
  assert.deepEqual(await readdir(slidesRoot), []);
  assert.deepEqual(await chromeLeftAfter(5_000), []);
});

test('buildDeck: a web page whose text fits the first screen but whose picture goes on (a tall canvas) is covered to its end', { timeout: 60_000 }, async t => {
  const dir = await tempDir(t);
  await writeFile(join(dir, 'chart.html'), '<!doctype html><title>Quarterly chart</title><body style="margin:0;padding:20px 80px;font:20px sans-serif"><h1>Quarterly results</h1><p>The chart below shows every quarter.</p><canvas id="c" width="1000" height="2000" style="display:block"></canvas><script>const g = document.getElementById("c").getContext("2d"); g.fillStyle = "#1a73e8"; g.fillRect(0, 0, 1000, 2000);</script></body>');
  const deck = await buildDeck(join(dir, 'chart.html'), { slidesRoot: join(dir, 'slides') });
  const [slide] = deck.slides;
  assert.ok(slide.pageHeight > 3000, `page picture ${slide.pageHeight} px tall`);
  const { views } = slide;
  assert.ok(views.length >= 3, `${views.length} views`);
  near(views[0].y, 0);
  near(views.at(-1).y + views.at(-1).h, 1); // down to the end of the picture
  for (const [index, view] of views.entries()) if (index) assert.ok(view.y <= views[index - 1].y + views[index - 1].h, 'a gap between two views');
  assert.equal(deck.truncated, undefined);
});

test('buildDeck: a URL that serves a PDF or a picture builds that deck, not Chrome\'s viewer; other types, errors after load and refused navigations fail', { timeout: 90_000 }, async t => {
  const dir = await tempDir(t);
  const picture = join(dir, 'tall.png');
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=400x1200:rate=1', '-frames:v', '1', picture]);
  const [pdf, png] = [await readFile(projectile), await readFile(picture)];
  const server = createServer((request, response) => {
    const send = (type, body) => { response.writeHead(200, { 'content-type': type }); response.end(body); };
    if (request.url === '/paper.pdf') return send('application/pdf', pdf);
    if (request.url === '/view?id=7') return send('image/png', png);
    if (request.url === '/data.json') return send('application/json', '{"a":1}');
    if (request.url === '/moving') return send('text/html', '<title>Moving</title><h1>Moving</h1><script>setTimeout(() => { location.href = "/gone"; }, 50)</script>');
    if (request.url === '/file') { response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="x.bin"' }); return response.end('bytes'); }
    response.writeHead(404, { 'content-type': 'text/html' });
    response.end('<title>Not found</title><h1>404 Not Found</h1>');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const slidesRoot = join(dir, 'slides');
  const paper = await buildDeck(`${base}/paper.pdf`, { slidesRoot });
  const local = await buildDeck(projectile, { slidesRoot, slug: 'local-paper' });
  assert.deepEqual([paper.slug, paper.source, paper.pages], ['127-0-0-1-paper-pdf', `${base}/paper.pdf`, 1]);
  assert.deepEqual(paper.slides.map(slide => slide.views.map(rectOf)), local.slides.map(slide => slide.views.map(rectOf))); // the deck the file makes
  assert.ok(paper.slides[0].views[0].lines.some(line => line.text === 'Projectile Motion'));
  for (const view of paper.slides[0].views) assert.deepEqual(await sizeOf(slidesRoot, view.asset), { width: 1920, height: 1080 });
  const pic = await buildDeck(`${base}/view?id=7`, { slidesRoot });
  assert.deepEqual([pic.slug, pic.slides[0].pageWidth, pic.slides[0].pageHeight, pic.slides[0].body], ['127-0-0-1-view', 400, 1200, 'image:/slides/127-0-0-1-view/page-1.png']);
  assert.deepEqual(pic.slides[0].views.map(rectOf), planUniformViews({ pageAspect: 1200 / 400 }));
  assert.deepEqual(pngSize(await readFile(join(slidesRoot, pic.slug, 'page-1.png'))), { width: 400, height: 1200 });
  await assert.rejects(buildDeck(`${base}/data.json`, { slidesRoot }), /serves application\/json/);
  await assert.rejects(buildDeck(`${base}/moving`, { slidesRoot }), /HTTP 404 for .*\/gone/);
  await assert.rejects(buildDeck(`${base}/file`, { slidesRoot }), /is a file download/);
  // A local page that refreshes to a file outside its folder: the refused navigation fails the build (no deck of Chrome's error page).
  await mkdir(join(dir, 'site'));
  await writeFile(join(dir, 'site', 'refresh.html'), `<!doctype html><title>Refresh</title><meta http-equiv="refresh" content="0; url=${pathToFileURL(picture).href}"><h1>About to move</h1>`);
  await assert.rejects(buildDeck(join(dir, 'site', 'refresh.html'), { slidesRoot }), /moved to file:.*which a deck may not load/);
  assert.deepEqual((await readdir(slidesRoot)).sort(), ['127-0-0-1-paper-pdf', '127-0-0-1-view', 'local-paper']);
});

// The picture with EXIF Orientation `orientation` (IFD0 with only that tag): an APP1 segment after a JPEG's SOI, or an
// eXIf chunk before a PNG's first IDAT.
function withOrientation(bytes, orientation) {
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0]);
  if (bytes[0] === 0xff) {
    const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    return Buffer.concat([bytes.subarray(0, 2), Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body, bytes.subarray(2)]);
  }
  const chunk = Buffer.alloc(12 + tiff.length); // length, type, data, CRC of type and data
  chunk.writeUInt32BE(tiff.length, 0);
  chunk.write('eXIf', 4, 'latin1');
  tiff.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + tiff.length)), 8 + tiff.length);
  const idat = bytes.indexOf('IDAT') - 4;
  return Buffer.concat([bytes.subarray(0, idat), chunk, bytes.subarray(idat)]);
}
const COLOURS = { red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], white: [255, 255, 255] };
const colourOf = pixel => Object.entries(COLOURS).map(([name, ref]) => [name, ref.reduce((sum, value, index) => sum + (value - pixel[index]) ** 2, 0)]).sort((a, b) => a[1] - b[1])[0][0];

test('buildDeck: a photo with EXIF orientation is upright as Chrome shows it: its size, its page picture and its renders (JPEG 1-8, PNG eXIf)', { timeout: 90_000 }, async t => {
  const dir = await tempDir(t);
  const slidesRoot = join(dir, 'slides');
  const quadrants = 'color=c=red:s=320x240,drawbox=x=160:y=0:w=160:h=120:color=0x00ff00:t=fill,drawbox=x=0:y=120:w=160:h=120:color=0x0000ff:t=fill,drawbox=x=160:y=120:w=160:h=120:color=0xffffff:t=fill';
  const [jpeg, png] = [join(dir, 'raw.jpg'), join(dir, 'raw.png')];
  await ffmpeg(['-f', 'lavfi', '-i', quadrants, '-frames:v', '1', '-q:v', '2', jpeg]);
  await ffmpeg(['-f', 'lavfi', '-i', quadrants, '-frames:v', '1', png]);
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath: process.env.ROBOMEET_CHROME_PATH || '/usr/bin/google-chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  // What Chrome (the stage) shows: the size, and the colour at the centre of each quadrant (TL, TR, BL, BR).
  const shown = async file => page.evaluate(async data => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)]));
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const at = (fx, fy) => [...context.getImageData(Math.floor(bitmap.width * fx), Math.floor(bitmap.height * fy), 1, 1).data].slice(0, 3);
    return { width: bitmap.width, height: bitmap.height, quadrants: [at(0.25, 0.25), at(0.75, 0.25), at(0.25, 0.75), at(0.75, 0.75)] };
  }, [...await readFile(file)]);
  const cases = [...[1, 2, 3, 4, 5, 6, 7, 8].map(orientation => [jpeg, orientation]), [png, 6]];
  for (const [raw, orientation] of cases) {
    const file = join(dir, `photo-${orientation}${extname(raw)}`);
    await writeFile(file, withOrientation(await readFile(raw), orientation));
    const label = `${extname(raw)} orientation ${orientation}`;
    const truth = await shown(file);
    const [slide] = (await buildDeck(file, { slidesRoot })).slides;
    assert.deepEqual([slide.pageWidth, slide.pageHeight], [truth.width, truth.height], `${label}: page size`);
    const picture = await shown(fileOf(slidesRoot, slide.body.slice('image:'.length)));
    assert.deepEqual([picture.width, picture.height], [truth.width, truth.height], `${label}: page picture size`);
    assert.deepEqual(picture.quadrants.map(colourOf), truth.quadrants.map(colourOf), `${label}: page picture`);
    // The first view starts at the picture's top: the top of its render is the top half of the picture.
    const render = await shown(fileOf(slidesRoot, slide.views[0].asset));
    assert.deepEqual(render.quadrants.slice(0, 2).map(colourOf), truth.quadrants.slice(0, 2).map(colourOf), `${label}: first render`);
  }
});

test('buildDeck: what a deck leaves out is in deck.json: a PDF cut at maxPages, a web page taller than the page picture cap', { timeout: 90_000 }, async t => {
  const dir = await tempDir(t);
  const slidesRoot = join(dir, 'slides');
  const three = join(dir, 'three.pdf');
  await run('pdfunite', [projectile, projectile, projectile, three]);
  const cut = await buildDeck(three, { slidesRoot, maxPages: 2 });
  const { message, ...truncated } = cut.truncated;
  assert.deepEqual([cut.pages, truncated], [2, { reason: 'maxPages', pages: 2, totalPages: 3 }]);
  assert.match(message, /Stopped at 2 of 3 pages/);
  assert.deepEqual(JSON.parse(await readFile(join(slidesRoot, 'three', 'deck.json'), 'utf8')).truncated, cut.truncated);
  const whole = await buildDeck(three, { slidesRoot, maxPages: 3 });
  assert.deepEqual([whole.pages, whole.truncated], [3, undefined]);
  assert.equal(JSON.parse(await readFile(join(slidesRoot, 'three', 'deck.json'), 'utf8')).truncated, undefined);
  // 50 bands of 500 CSS px: 25000 CSS px = 37500 device px, over the 30000 px page picture.
  const bands = Array.from({ length: 50 }, (_, index) => `<div style="height:500px;box-sizing:border-box;padding:20px;border-top:2px solid #888"><h2>Band ${index + 1} of 50</h2></div>`).join('');
  await writeFile(join(dir, 'long.html'), `<!doctype html><title>Long page</title><body style="margin:0;font:20px sans-serif">${bands}</body>`);
  const long = await buildDeck(join(dir, 'long.html'), { slidesRoot });
  assert.equal(long.slides[0].pageHeight, 30000);
  assert.deepEqual([long.truncated.reason, long.truncated.shownPx, long.truncated.totalPx], ['page-height', 30000, 37500]);
  assert.match(long.truncated.message, /cut at 30000 of 37500 px/);
});

test('deckSlug: the default slug unless another source\'s deck holds it; names with no Latin letters get a stable slug of their own', async t => {
  const slidesRoot = await tempDir(t);
  const deckAt = async (slug, source) => { await mkdir(join(slidesRoot, slug), { recursive: true }); await writeFile(join(slidesRoot, slug, 'deck.json'), JSON.stringify({ slug, source })); };
  const view = id => `https://news.example.com/view?id=${id}`;
  assert.equal(await deckSlug(slidesRoot, view(101)), 'news-example-com-view'); // free
  await deckAt('news-example-com-view', view(101));
  assert.equal(await deckSlug(slidesRoot, view(101)), 'news-example-com-view'); // the same source: rebuilt in place
  assert.equal(await deckSlug(slidesRoot, view(202)), 'news-example-com-view-2');
  await deckAt('news-example-com-view-2', view(303));
  assert.equal(await deckSlug(slidesRoot, view(202)), 'news-example-com-view-3');
  await mkdir(join(slidesRoot, 'notes')); // a folder that is not a deck is never taken over
  assert.equal(await deckSlug(slidesRoot, '/talks/notes.pdf'), 'notes-2');
  await deckAt('report', '/a/report.pdf');
  assert.equal(await deckSlug(slidesRoot, pathToFileURL('/a/report.pdf').href), 'report');
  assert.equal(await deckSlug(slidesRoot, '/b/report.pptx'), 'report-2');
  const [chinese, russian] = [slugForInput('/home/u/报告.pdf'), slugForInput('/home/u/Отчёт.docx')];
  assert.match(chinese, /^deck-[0-9a-f]{8}$/);
  assert.match(russian, /^deck-[0-9a-f]{8}$/);
  assert.notEqual(chinese, russian);
  assert.equal(slugForInput('/home/u/报告.pdf'), chinese); // stable
  assert.equal(slugForInput('/docs/Café Menü.pdf'), 'cafe-menu'); // accented letters kept as letters
  for (const slug of [chinese, 'news-example-com-view-3', slugForInput(`https://example.com/${'x'.repeat(100)}`)]) assert.ok(DECK_SLUG.test(slug), slug);
});

test('bin/deck.mjs build: --max-pages cuts with a warning, --slug must be presentable, default slugs never take another source\'s deck', { timeout: 90_000 }, async t => {
  const dir = await tempDir(t);
  const slidesRoot = join(dir, 'slides');
  const three = join(dir, 'three.pdf');
  await run('pdfunite', [projectile, projectile, projectile, three]);
  const build = (...args) => run(process.execPath, [cli, 'build', ...args, '--slides-root', slidesRoot], { cwd: root });
  const cut = await build(three, '--max-pages', '2');
  const printed = JSON.parse(cut.stdout);
  assert.deepEqual([printed.slug, printed.pages, printed.truncated?.reason, printed.truncated?.totalPages], ['three', 2, 'maxPages', 3]);
  assert.match(cut.stderr, /Warning: Stopped at 2 of 3 pages.*--max-pages/);
  for (const bad of ['0', '201', 'many']) await assert.rejects(build(three, '--max-pages', bad), /--max-pages must be a whole number from 1 to 200/);
  // Pictures with the same name in two folders: two decks, and a rebuild of the first keeps its slug.
  const [a, b] = [join(dir, 'a'), join(dir, 'b')];
  for (const [folder, colour] of [[a, 'red'], [b, 'blue']]) {
    await mkdir(folder);
    await ffmpeg(['-f', 'lavfi', '-i', `color=c=${colour}:size=320x180`, '-frames:v', '1', join(folder, 'report.png')]);
  }
  const slugOf = async (...args) => JSON.parse((await build(...args)).stdout).slug;
  assert.equal(await slugOf(join(a, 'report.png')), 'report');
  assert.equal(await slugOf(join(b, 'report.png')), 'report-2');
  assert.equal(await slugOf(join(a, 'report.png')), 'report');
  assert.equal(JSON.parse(await readFile(join(slidesRoot, 'report-2', 'deck.json'), 'utf8')).source, join(b, 'report.png'));
  // --slug is cleaned to letters, digits and '-', then must be a slug the server presents; otherwise nothing is built.
  assert.equal(await slugOf(join(a, 'report.png'), '--slug', 'Q3_report v1.2'), 'q3-report-v1-2');
  await assert.rejects(build(join(a, 'report.png'), '--slug', '报告'), /Invalid --slug/);
  await assert.rejects(build(join(a, 'report.png'), '--slug', 'x'.repeat(82)), /Invalid --slug/);
  assert.deepEqual((await readdir(slidesRoot)).sort(), ['q3-report-v1-2', 'report', 'report-2', 'three']);
});

test('isLocalAddress: loopback, private, link-local, CGNAT, unspecified and multicast addresses (IPv4-mapped too), and no public one', () => {
  for (const address of ['127.0.0.1', '127.8.9.10', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.4.47', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) assert.equal(isLocalAddress(address), true, address);
  for (const address of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '11.0.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isLocalAddress(address), false, address);
});

// This machine's first IPv4 address that is not loopback: a page served there is not on 127.0.0.1's host.
const otherAddress = () => Object.values(networkInterfaces()).flat().find(item => item?.family === 'IPv4' && !item.internal)?.address;

test('buildDeck: a web URL page cannot reach this machine\'s local services (a frame, a redirect, fetch, a WebSocket), and Chrome keeps its sandbox', { timeout: 60_000 }, async t => {
  const outerHost = otherAddress();
  if (!outerHost) { t.skip('no IPv4 address other than loopback to serve the outer page from'); return; }
  const internal = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' });
    response.end(request.url === '/data' ? 'LEAKED-HTTP' : '<body style="margin:0;background:#cc0000"></body>');
  });
  await new Promise(done => internal.listen(0, '127.0.0.1', done));
  const sockets = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  sockets.on('connection', socket => socket.send('LEAKED-WS'));
  await new Promise(done => sockets.on('listening', done));
  const inner = `http://127.0.0.1:${internal.address().port}`;
  const outer = createServer((request, response) => {
    if (request.url.startsWith('/hop')) { response.writeHead(302, { location: request.url === '/hop' ? `${inner}/` : `${inner}/data` }); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><title>Shared link</title><body style="margin:0;font:20px sans-serif">
<iframe src="${inner}/" style="display:block;border:0" width="600" height="150"></iframe><iframe src="/hop" style="display:block;border:0" width="600" height="150"></iframe>
<p id="direct">direct: waiting</p><p id="redirected">redirected: waiting</p><p id="socket">socket: waiting</p>
<script>
const put = (id, text) => { document.getElementById(id).textContent = id + ': ' + text; };
fetch('${inner}/data').then(r => r.text()).then(text => put('direct', text), () => put('direct', 'refused'));
fetch('/hop-data').then(r => r.text()).then(text => put('redirected', text), () => put('redirected', 'refused'));
const socket = new WebSocket('ws://127.0.0.1:${sockets.address().port}/');
socket.onmessage = event => put('socket', event.data);
socket.onerror = () => put('socket', 'refused');
</script></body>`);
  });
  await new Promise(done => outer.listen(0, outerHost, done));
  t.after(() => { internal.closeAllConnections(); internal.close(); outer.closeAllConnections(); outer.close(); sockets.close(); });
  const slidesRoot = await tempDir(t);
  const seen = new Set();
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  const watch = setInterval(async () => { for (const line of await chromeChildren()) seen.add(line); }, 100);
  let deck;
  try { deck = await buildDeck(`http://${outerHost}:${outer.address().port}/`, { slidesRoot, slug: 'shared-link' }); }
  finally { clearInterval(watch); console.warn = warn; }
  const text = deck.slides[0].views.flatMap(view => view.lines.map(line => line.text));
  assert.deepEqual(text.filter(line => /^(direct|redirected|socket):/.test(line)), ['direct: refused', 'redirected: refused', 'socket: refused']);
  // The two frames (CSS y 0-150 and 150-300, x 1.5 on the page picture) do not show the internal page.
  for (const y of [112, 337]) {
    const [r, g, b] = await rgb(join(slidesRoot, 'shared-link', 'page-1.png'), `crop=1:1:300:${y}`);
    assert.ok(!(r > 180 && g < 60 && b < 60), `the frame at y ${y} shows the internal page: ${[r, g, b]}`);
  }
  // A link that redirects the page itself to a local address fails, saying why.
  await assert.rejects(buildDeck(`http://${outerHost}:${outer.address().port}/hop`, { slidesRoot }), /HTTP 403 .*127\.0\.0\.1 is a local-network address/);
  assert.ok(seen.size, 'Chrome was never seen running');
  if (warnings.some(line => /sandbox cannot start/.test(line))) t.diagnostic('Chrome\'s sandbox cannot start on this machine: its use is not checked');
  else assert.deepEqual([...seen].filter(line => /--no-sandbox/.test(line)), []);
});

test('buildDeck: a local HTML file that is a symlink is captured from its real folder (its pictures load, the folder rule holds)', { timeout: 60_000 }, async t => {
  const dir = await tempDir(t);
  const [real, site] = [join(dir, 'real'), join(dir, 'site')];
  await mkdir(real);
  await mkdir(site);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x00ff00:size=200x100', '-frames:v', '1', join(real, 'green.png')]);
  await writeFile(join(real, 'page.html'), '<!doctype html><title>Real page</title><body style="margin:0;font:20px sans-serif"><img src="green.png" width="200" height="100" style="display:block"><h1>Linked page</h1></body>');
  await symlink(join(real, 'page.html'), join(site, 'linked.html'));
  const deck = await buildDeck(join(site, 'linked.html'), { slidesRoot: join(dir, 'slides') });
  assert.deepEqual([deck.slug, deck.title, deck.source], ['linked', 'Real page', join(site, 'linked.html')]);
  assert.ok(deck.slides[0].views[0].lines.some(line => line.text === 'Linked page'));
  const [r, g, b] = await rgb(join(dir, 'slides', 'linked', 'page-1.png'), 'crop=1:1:150:75');
  assert.ok(r < 40 && g > 215 && b < 40, `the picture beside the real page did not load: ${[r, g, b]}`);
});

test('buildDeck: where Chrome\'s sandbox cannot start, the page is captured without it and stderr says why', { timeout: 60_000 }, async t => {
  const dir = await tempDir(t);
  // Stands in for a machine without a usable sandbox: this "Chrome" starts only when given --no-sandbox.
  const chrome = join(dir, 'chrome-without-sandbox.sh');
  await writeFile(chrome, `#!/bin/sh\ncase " $* " in *" --no-sandbox "*) exec ${process.env.ROBOMEET_CHROME_PATH || '/usr/bin/google-chrome'} "$@";; esac\necho "FATAL: No usable sandbox!" >&2\nexit 1\n`, { mode: 0o755 });
  await writeFile(join(dir, 'page.html'), htmlPage('Fallback Page'));
  const { stdout, stderr } = await run(process.execPath, [cli, 'build', join(dir, 'page.html'), '--slides-root', join(dir, 'slides')], { cwd: root, env: { ...process.env, ROBOMEET_CHROME_PATH: chrome } });
  assert.equal(JSON.parse(stdout).title, 'Fallback Page');
  assert.match(stderr, /sandbox cannot start here, so the page is captured without it \(.*sandbox/i);
});
