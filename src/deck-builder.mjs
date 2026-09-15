// PDF -> stage deck (docs/stage-design.md). For every page:
//   - one page picture at `pageWidth` px wide (the stage scrolls and zooms over it),
//   - fit-to-width reading windows ("views") stepping down the page, snapped so no text line is cut at the top,
//   - a pixel-exact render of every view, drawn 1:1 once the stage rests on it (no resampling blur): 1920x1080 for
//     fit-width views; a view of another aspect (a whole page) is rendered as large as fits inside 1920x1080,
//   - the text lines and blocks inside every view, in reading order, each { text, x, y, w, h } normalized to the
//     page, so a narrator can describe exactly what is visible and pick highlight rectangles (highlightFor).
// Writes public/slides/<slug>/deck.json and returns the same object. Needs poppler (pdftoppm, pdftotext, pdfinfo).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, readFile, writeFile, stat, rename } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { tmpdir } from 'node:os';

const run = promisify(execFile);
const STAGE_W = 1920;
const STAGE_H = 1080;
const HIGHLIGHT_PAD = 0.004; // page-normalized; the stage adds its own 14 px around a highlight

export function slugFor(pdfPath) {
  return basename(pdfPath, extname(pdfPath)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'deck';
}

const attr = (tag, name) => Number((tag.match(new RegExp(`${name}="([-0-9.]+)"`)) || [])[1]);
const unescape = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const r4 = value => Math.round(value * 1e4) / 1e4;

// pdftotext -bbox-layout XHTML -> [{ width, height, blocks: [{ x0, y0, x1, y1, lines: [{ x0, y0, x1, y1, text }] }] }] (points)
export function parseBboxLayout(xhtml) {
  const pages = [];
  for (const pageMatch of xhtml.matchAll(/<page\b[^>]*>([\s\S]*?)<\/page>/g)) {
    const pageTag = pageMatch[0].slice(0, pageMatch[0].indexOf('>') + 1);
    const page = { width: attr(pageTag, 'width'), height: attr(pageTag, 'height'), blocks: [] };
    for (const blockMatch of pageMatch[1].matchAll(/<block\b[^>]*>([\s\S]*?)<\/block>/g)) {
      const blockTag = blockMatch[0].slice(0, blockMatch[0].indexOf('>') + 1);
      const block = { x0: attr(blockTag, 'xMin'), y0: attr(blockTag, 'yMin'), x1: attr(blockTag, 'xMax'), y1: attr(blockTag, 'yMax'), lines: [] };
      for (const lineMatch of blockMatch[1].matchAll(/<line\b[^>]*>([\s\S]*?)<\/line>/g)) {
        const lineTag = lineMatch[0].slice(0, lineMatch[0].indexOf('>') + 1);
        const words = [...lineMatch[1].matchAll(/<word\b[^>]*>([\s\S]*?)<\/word>/g)].map(match => unescape(match[1]));
        block.lines.push({ x0: attr(lineTag, 'xMin'), y0: attr(lineTag, 'yMin'), x1: attr(lineTag, 'xMax'), y1: attr(lineTag, 'yMax'), text: words.join(' ') });
      }
      page.blocks.push(block);
    }
    pages.push(page);
  }
  return pages;
}

// A page number in the footer ("7", "- 7 -", "Page 7", "7 / 12", "Page 7 of 12") must not add a window of its own.
const FOLIO = /^(page\s*)?[-–—\s]*\d{1,4}[-–—\s]*((\/|of)\s*\d{1,4})?$/i;
const isFolio = line => { const text = String(line.text || '').trim(); return line.y0 > 0.9 && (text.length <= 4 || FOLIO.test(text)); };

// Fit-to-width windows over one page, in page-normalized units. Pure; unit-tested.
export function planViews({ pageAspect, lines = [], overlap = 0.1, margin = 0.025 }) {
  // pageAspect = height / width. A full-width 16:9 window covers this fraction of the page height:
  const h = (STAGE_H / STAGE_W) / pageAspect;
  if (h >= 1) return [{ x: 0, y: 0, w: 1, h: 1 }]; // at least as wide as 16:9: the whole page, letterboxed
  const sorted = [...lines].filter(line => !isFolio(line)).sort((a, b) => a.y0 - b.y0);
  // No text (an empty page, a full-page figure, a scan): one view of the whole page.
  if (!sorted.length) return [{ x: 0, y: 0, w: 1, h: 1 }];
  const top = Math.max(0, sorted[0].y0 - margin);
  const bottom = Math.min(1, Math.max(...sorted.map(line => line.y1)) + margin);
  if (bottom - top <= h) {
    const y = Math.min(1 - h, Math.max(0, top - (h - (bottom - top)) / 2));
    return [{ x: 0, y, w: 1, h }];
  }
  // Rows: lines that overlap vertically (an equation and its number, two columns) form one row. A window may
  // only start in the whitespace between two rows, so no text is ever cut by its top edge.
  const rows = [];
  for (const line of sorted) {
    const last = rows.at(-1);
    if (last && line.y0 < last.y1) last.y1 = Math.max(last.y1, line.y1);
    else rows.push({ y0: line.y0, y1: line.y1 });
  }
  const gaps = rows.slice(1).map((row, index) => (rows[index].y1 + row.y0) / 2);
  const views = [];
  let y = top;
  for (let guard = 0; guard < 60; guard++) {
    const clamped = Math.min(1 - h, Math.max(0, y));
    views.push({ x: 0, y: clamped, w: 1, h });
    if (clamped + h >= bottom - 0.01) break;
    const nominal = clamped + h * (1 - overlap);
    const floor = clamped + h * 0.3; // keep moving forward
    const candidates = gaps.filter(gap => gap > floor && gap <= nominal);
    let next = candidates.length ? Math.max(...candidates) : nominal;
    if (next + h >= bottom) {
      // Last window: it must reach the end of the content (top >= bottom - h) and stay on the page (top <= 1 - h);
      // start it at the earliest gap that does (a shorter step than `floor` if the page end forces it, since
      // clamping a later gap back to 1 - h could cut a row), else exactly bottom - h.
      const fits = gap => gap >= bottom - h && gap <= Math.min(nominal, 1 - h);
      const covering = gaps.filter(gap => gap > floor && fits(gap));
      const late = covering.length ? covering : gaps.filter(gap => gap > clamped && fits(gap));
      next = late.length ? Math.min(...late) : Math.min(1 - h, Math.max(floor, bottom - h));
    }
    y = next;
  }
  return views;
}

// Highlight rectangle for `phrase` in a view: the view lines holding its first occurrence in reading order (a phrase
// may run over consecutive lines), as their union, padded a little, normalized to the page. Matching is
// case-insensitive and whitespace-normalized, then retried ignoring spaces, because pdftotext splits math
// ("v 0 cos θ" for v0 cos θ). Null when nothing matches or the lines carry no boxes (decks built before lines
// were objects).
const squash = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const hasBox = line => line && typeof line === 'object' && [line.x, line.y, line.w, line.h].every(Number.isFinite);
function locate(texts, target, joiner) {
  let joined = '';
  const owner = []; // line index of every character of `joined`
  texts.forEach((text, index) => {
    if (!text) return;
    if (joined && joiner) { joined += joiner; owner.push(index); }
    joined += text;
    for (let i = 0; i < text.length; i++) owner.push(index);
  });
  const at = target ? joined.indexOf(target) : -1;
  return at < 0 ? null : [...new Set(owner.slice(at, at + target.length))];
}
export function highlightFor(view, phrase) {
  const lines = (Array.isArray(view?.lines) ? view.lines : []).filter(hasBox);
  const wanted = squash(phrase);
  if (!wanted || !lines.length) return null;
  const texts = lines.map(line => squash(line.text));
  const hit = locate(texts, wanted, ' ') || locate(texts.map(text => text.replace(/ /g, '')), wanted.replace(/ /g, ''), '');
  if (!hit) return null;
  const chosen = hit.map(index => lines[index]);
  const x0 = Math.min(...chosen.map(line => line.x)), x1 = Math.max(...chosen.map(line => line.x + line.w));
  const y0 = Math.min(...chosen.map(line => line.y)), y1 = Math.max(...chosen.map(line => line.y + line.h));
  // Pad, but never past the page, nor past an edge of the view the lines are inside of.
  const vx = Number.isFinite(view.x) ? view.x : 0, vy = Number.isFinite(view.y) ? view.y : 0;
  const vw = Number.isFinite(view.w) ? view.w : 1, vh = Number.isFinite(view.h) ? view.h : 1;
  const low = (value, edge) => Math.max(0, value >= edge ? Math.max(edge, value - HIGHLIGHT_PAD) : value - HIGHLIGHT_PAD);
  const high = (value, edge) => Math.min(1, value <= edge ? Math.min(edge, value + HIGHLIGHT_PAD) : value + HIGHLIGHT_PAD);
  const left = low(x0, vx), top = low(y0, vy), right = high(x1, vx + vw), bottom = high(y1, vy + vh);
  return { x: r4(left), y: r4(top), w: r4(right - left), h: r4(bottom - top) };
}

// pdfinfo -> { title, rotation: { [page]: degrees } }. For a /Rotate 90 or 270 page pdftotext reports the box
// unrotated while its text coordinates and pdftoppm's picture are rotated, so width and height must be swapped.
async function pdfInfo(pdfPath, lastPage) {
  try {
    const { stdout } = await run('pdfinfo', ['-f', '1', '-l', String(lastPage), pdfPath], { maxBuffer: 16 << 20 });
    const rotation = {};
    for (const [, page, degrees] of stdout.matchAll(/^Page\s+(\d+)\s+rot:\s+(-?\d+)/gm)) rotation[page] = ((Number(degrees) % 360) + 360) % 360;
    return { title: ((stdout.match(/^Title:[ \t]*(.*)$/m) || [])[1] || '').trim(), rotation };
  } catch { return { title: '', rotation: {} }; }
}

// dpi and pixel size of a view rendered as large as fits the stage (fit-width views: exactly 1920x1080).
function renderBox(rect, widthIn, heightIn) {
  const dpi = Number(Math.min(STAGE_W / (rect.w * widthIn), STAGE_H / (rect.h * heightIn)).toFixed(4));
  return { dpi, width: Math.min(STAGE_W, Math.round(rect.w * widthIn * dpi)), height: Math.min(STAGE_H, Math.round(rect.h * heightIn * dpi)) };
}

export async function buildPdfDeck(pdfPath, { slidesRoot, slug = slugFor(pdfPath), title, pageWidth = 2400, maxPages = 60, overlap = 0.1, exactViews = true } = {}) {
  if (!slidesRoot) throw new Error('slidesRoot is required');
  // The deck directory is wiped first, so the slug must stay inside slidesRoot (and match the stage's asset paths).
  if (!/^[A-Za-z0-9._-]+$/.test(slug) || /^\.+$/.test(slug)) throw new Error(`Unsafe deck slug: ${slug}`);
  const source = await stat(pdfPath);
  if (!source.isFile()) throw new Error(`Not a file: ${pdfPath}`);
  // Build into a fresh sibling directory and swap it in only when the whole deck is written: a failed build (a bad or
  // mistyped input, a poppler error) never destroys the deck that is already there.
  const dir = join(slidesRoot, slug);
  const building = join(slidesRoot, `.${slug}.building-${process.pid}-${Date.now()}`);
  await mkdir(building, { recursive: true });
  try {
    const built = await buildInto(building);
    await rm(dir, { recursive: true, force: true });
    await rename(building, dir);
    return { ...built, dir };
  } catch (error) {
    await rm(building, { recursive: true, force: true });
    throw error;
  }
  async function buildInto(dir) {
  const bboxFile = join(tmpdir(), `robomeet-bbox-${process.pid}-${Date.now()}.html`);
  await run('pdftotext', ['-bbox-layout', '-l', String(maxPages), pdfPath, bboxFile]);
  const layout = parseBboxLayout(await readFile(bboxFile, 'utf8'));
  await rm(bboxFile, { force: true });
  const pages = layout.slice(0, maxPages);
  const info = await pdfInfo(pdfPath, Math.max(1, pages.length));
  const slides = [];
  for (let index = 0; index < pages.length; index++) {
    const number = index + 1;
    const page = info.rotation[number] % 180 === 90 ? { ...pages[index], width: pages[index].height, height: pages[index].width } : pages[index];
    const widthIn = page.width / 72;
    const heightIn = page.height / 72;
    const aspect = page.height / page.width;
    const pageFile = `page-${number}.png`;
    const pageDpi = pageWidth / widthIn;
    await run('pdftoppm', ['-png', '-r', pageDpi.toFixed(4), '-f', String(number), '-l', String(number), '-singlefile', pdfPath, join(dir, `page-${number}`)]);
    const lines = page.blocks.flatMap(block => block.lines).map(line => ({ x0: line.x0 / page.width, y0: line.y0 / page.height, x1: line.x1 / page.width, y1: line.y1 / page.height, text: line.text }));
    const blocks = page.blocks.map(block => ({ x: r4(block.x0 / page.width), y: r4(block.y0 / page.height), w: r4((block.x1 - block.x0) / page.width), h: r4((block.y1 - block.y0) / page.height), text: block.lines.map(line => line.text).join(' ') }));
    const views = [];
    for (const [viewIndex, rect] of planViews({ pageAspect: aspect, lines, overlap }).entries()) {
      const within = (top, height) => top + height / 2 >= rect.y && top + height / 2 <= rect.y + rect.h;
      const view = {
        ...rect,
        lines: lines.filter(line => within(line.y0, line.y1 - line.y0)).map(line => ({ text: line.text, x: r4(line.x0), y: r4(line.y0), w: r4(line.x1 - line.x0), h: r4(line.y1 - line.y0) })),
        blocks: blocks.filter(block => within(block.y, block.h)),
      };
      if (exactViews) {
        // Render exactly this window, as large as fits the stage; crop offsets clamped so the crop stays on the page.
        const { dpi, width, height } = renderBox(rect, widthIn, heightIn);
        const file = `page-${number}-view-${viewIndex + 1}.png`;
        const x = Math.max(0, Math.min(Math.round(rect.x * widthIn * dpi), Math.floor(widthIn * dpi - width)));
        const y = Math.max(0, Math.min(Math.round(rect.y * heightIn * dpi), Math.floor(heightIn * dpi - height)));
        await run('pdftoppm', ['-png', '-r', dpi.toFixed(4), '-f', String(number), '-l', String(number), '-x', String(x), '-y', String(y), '-W', String(width), '-H', String(height), '-singlefile', pdfPath, join(dir, file.replace(/\.png$/, ''))]);
        view.asset = `/slides/${slug}/${file}`;
      }
      views.push(view);
    }
    slides.push({ title: `Page ${number}`, body: `image:/slides/${slug}/${pageFile}`, page: number, pageWidth: page.width, pageHeight: page.height, views });
  }
  // Title: the caller's, else the PDF's metadata Title, else the slug.
  const deck = { title: title || info.title || slug, slug, source: pdfPath, pages: pages.length, slides };
  await writeFile(join(dir, 'deck.json'), JSON.stringify(deck, null, 2));
  return deck;
  }
}
