#!/usr/bin/env node
// Stage decks from PDFs, office files, web pages and pictures (docs/stage-design.md, src/deck-formats.mjs), and two
// checks for the narration a coding agent writes into deck.json (views[].say, views[].highlight):
//   node bin/deck.mjs build <input> [--slug S] [--title T] [--fit page|width] [--page-width 2400] [--max-pages N]
//                                   -> builds public/slides/<slug>/, prints JSON. <input>: .pdf; .pptx .ppt .odp (fit page
//                                      by default); .docx .doc .odt .rtf; .html .htm; .png .jpg .jpeg .webp; http(s) URL.
//                                      --max-pages: 1-200 (default 60). Without --slug the slug is one no other source's
//                                      deck holds (deckSlug). A deck that leaves part of the input out prints a warning
//                                      on stderr and has "truncated" in its JSON
//   node bin/deck.mjs sheet <slug>  -> contact sheets public/slides/<slug>/sheet-<n>.png, 4 views each (2x2): every
//                                      view's exact render at 960x540, its highlight, and a caption strip with its say
//   node bin/deck.mjs check <slug>  -> JSON report per view: say length, coverage of the visible text, highlight
// Every command also takes --slides-root DIR (default public/slides).
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { highlightFor } from '../src/deck-builder.mjs';
import { DECK_SLUG, buildDeck, deckSlug } from '../src/deck-formats.mjs';

const USAGE = `Usage:
  node bin/deck.mjs build <input> [--slug S] [--title T] [--fit page|width] [--page-width 2400] [--max-pages N] [--slides-root DIR]
    <input>: .pdf .pptx .ppt .odp .docx .doc .odt .rtf .html .htm .png .jpg .jpeg .webp, or an http(s) URL
  node bin/deck.mjs sheet <slug> [--slides-root DIR]
  node bin/deck.mjs check <slug> [--slides-root DIR]`;
const LONG_SAY = 450; // characters; a longer beat keeps one view on stage too long
const LOW_COVERAGE = 0.3;
const CELL_W = 960;
const CELL_H = 540;
const PER_SHEET = 4;

// ---- check
// English function words plus spoken filler ("here we see", "let's look"); only words of 3+ letters matter.
const STOP = new Set(`the and for are but not you your yours with this that these those from into onto over under
  than then there here where when what which who whom whose why how all any each few more most other some such only
  own same very can could will would shall should may might must just now also its our ours out off get got has have
  had having was were been being does did doing done let lets see look looking one about above below again further
  once both their theirs them they his her hers him she yes okay well really thing things something going gonna
  notice because while after before during until upon per via etc`.split(/\s+/).filter(Boolean));
const words = text => [...new Set((String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z0-9]+/g) || [])
  .filter(word => word.length >= 3 && !STOP.has(word)))];
const lineText = line => (typeof line === 'string' ? line : String(line?.text || ''));
const viewsOf = slide => (Array.isArray(slide?.views) && slide.views.length ? slide.views : [{ x: 0, y: 0, w: 1, h: 1, say: slide?.say }]);
const rectOf = view => ({ x: Number.isFinite(view?.x) ? view.x : 0, y: Number.isFinite(view?.y) ? view.y : 0, w: Number.isFinite(view?.w) ? view.w : 1, h: Number.isFinite(view?.h) ? view.h : 1 });
const isRect = box => box && typeof box === 'object' && [box.x, box.y, box.w, box.h].every(Number.isFinite);
const inside = (box, rect, slack = 0.002) => box.x >= rect.x - slack && box.y >= rect.y - slack && box.x + box.w <= rect.x + rect.w + slack && box.y + box.h <= rect.y + rect.h + slack;
// A highlight is a page-normalized rect; a string is taken as a phrase and resolved against the view's lines.
const highlightBox = view => (typeof view?.highlight === 'string' ? highlightFor(view, view.highlight) : isRect(view?.highlight) ? view.highlight : null);

export function checkDeck(deck) {
  const report = { slug: deck.slug, title: deck.title, views: [], warnings: [] };
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  const narrated = slides.some(slide => viewsOf(slide).some(view => String(view.say || '').trim()));
  if (!narrated) report.warnings.push('No view has narration: add "say" to the views you want spoken.');
  slides.forEach((slide, slideIndex) => viewsOf(slide).forEach((view, viewIndex, all) => {
    const page = slide.page ?? slideIndex + 1;
    const where = `page ${page} part ${viewIndex + 1}/${all.length}`;
    const say = String(view.say || '').trim();
    const visible = new Set(words((Array.isArray(view.lines) ? view.lines : []).map(lineText).join(' ')));
    const spoken = words(say);
    const missing = spoken.filter(word => !visible.has(word));
    const coverage = spoken.length && visible.size ? Math.round((1 - missing.length / spoken.length) * 100) / 100 : null;
    let highlight = null;
    if (view.highlight) {
      const box = highlightBox(view);
      highlight = box ? { ...box, inside: inside(box, rectOf(view)) } : { inside: false, unresolved: String(view.highlight).slice(0, 120) };
      if (!box) report.warnings.push(`${where}: highlight "${String(view.highlight).slice(0, 60)}" matches no line of this view`);
      else if (!highlight.inside) report.warnings.push(`${where}: highlight is not inside the view`);
    }
    const flag = say.length > LONG_SAY ? 'split this beat' : null;
    if (flag) report.warnings.push(`${where}: say is ${say.length} characters (> ${LONG_SAY}): split this beat`);
    if (narrated && !say) report.warnings.push(`${where}: no narration (the narrated walk skips this view)`);
    if (coverage !== null && coverage < LOW_COVERAGE) report.warnings.push(`${where}: coverage ${coverage}: the say may describe what is not on screen (missing: ${missing.slice(0, 8).join(', ')})`);
    report.views.push({ page, part: viewIndex + 1, parts: all.length, hasSay: Boolean(say), sayLength: say.length, flag, coverage, missing, highlight });
  }));
  return report;
}

// ---- sheet
// '/slides/<slug>/<file>' -> file under slidesRoot, or null if it would leave slidesRoot.
function assetFile(asset, slidesRoot) {
  const match = /^\/slides\/(.+)$/.exec(String(asset || '').trim());
  if (!match) return null;
  const file = resolve(slidesRoot, match[1]);
  return file.startsWith(resolve(slidesRoot) + sep) ? file : null;
}
const exists = file => (file ? stat(file).then(info => info.isFile(), () => false) : false);

// One contact-sheet cell: picture bytes, the part of the picture that is the view (normalized to the picture), and
// the highlight normalized to the view.
async function cellFor({ slide, view, caption }, slidesRoot) {
  const rect = rectOf(view);
  const exact = assetFile(view.asset, slidesRoot);
  const body = typeof slide.body === 'string' && slide.body.startsWith('image:') ? assetFile(slide.body.slice(6), slidesRoot) : null;
  let bytes = null, crop = rect;
  if (await exists(exact)) { bytes = await readFile(exact); crop = { x: 0, y: 0, w: 1, h: 1 }; } // exact render = the view
  else if (await exists(body)) bytes = await readFile(body); // no exact render: crop the page picture
  const box = highlightBox(view);
  const highlight = box ? { x: (box.x - rect.x) / rect.w, y: (box.y - rect.y) / rect.h, w: box.w / rect.w, h: box.h / rect.h } : null;
  return { caption, say: String(view.say || '').trim(), bytes: bytes ? new Uint8Array(bytes) : null, crop, highlight };
}

// Runs in the page: draws up to 4 cells in a 2x2 grid and returns the sheet as a PNG data URL.
async function drawSheet({ cells, cellW, cellH }) {
  const GAP = 24, PAD = 18, HEAD = 40, LINE = 32;
  const font = (style, size) => `${style} ${size}px "DejaVu Sans", "Liberation Sans", Arial, sans-serif`;
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = font('normal', 24);
  const wrap = text => {
    const out = [];
    let line = '';
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (!line || measure.measureText(next).width <= cellW - 2 * PAD) { line = next; continue; }
      out.push(line);
      line = word;
    }
    if (line) out.push(line);
    return out;
  };
  const laid = cells.map(cell => ({ ...cell, lines: cell.say ? wrap(cell.say) : [] }));
  const rows = [laid.slice(0, 2), laid.slice(2, 4)].filter(row => row.length);
  const strip = rows.map(row => PAD + HEAD + Math.max(1, ...row.map(cell => cell.lines.length)) * LINE + PAD);
  const canvas = document.createElement('canvas');
  canvas.width = GAP * 3 + cellW * 2;
  canvas.height = GAP + rows.reduce((sum, _, index) => sum + cellH + strip[index] + GAP, 0);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#dadce0';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let top = GAP;
  for (const [rowIndex, row] of rows.entries()) {
    for (const [column, cell] of row.entries()) {
      const left = GAP + column * (cellW + GAP);
      ctx.fillStyle = '#202124'; // the stage's letterbox colour
      ctx.fillRect(left, top, cellW, cellH);
      if (cell.bytes) {
        const picture = await createImageBitmap(new Blob([cell.bytes]));
        const sx = cell.crop.x * picture.width, sy = cell.crop.y * picture.height;
        const sw = cell.crop.w * picture.width, sh = cell.crop.h * picture.height;
        const scale = Math.min(cellW / sw, cellH / sh);
        const dw = sw * scale, dh = sh * scale, dx = left + (cellW - dw) / 2, dy = top + (cellH - dh) / 2;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(picture, sx, sy, sw, sh, dx, dy, dw, dh);
        picture.close();
        if (cell.highlight) {
          // Same look as the stage (src/meet-stage.js drawHighlight), at half size, clipped to the view.
          ctx.save();
          ctx.beginPath();
          ctx.rect(left, top, cellW, cellH);
          ctx.clip();
          ctx.fillStyle = 'rgba(251, 188, 4, 0.12)';
          ctx.strokeStyle = '#f9ab00';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.roundRect(dx + cell.highlight.x * dw - 7, dy + cell.highlight.y * dh - 7, cell.highlight.w * dw + 14, cell.highlight.h * dh + 14, 8);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
      } else {
        ctx.fillStyle = '#e8eaed';
        ctx.font = font('normal', 24);
        ctx.fillText('(no picture for this view)', left + PAD, top + cellH / 2);
      }
      ctx.strokeStyle = '#5f6368';
      ctx.lineWidth = 1;
      ctx.strokeRect(left + 0.5, top + 0.5, cellW - 1, cellH - 1);
      const stripTop = top + cellH;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(left, stripTop, cellW, strip[rowIndex]);
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#202124';
      ctx.font = font('bold', 26);
      ctx.fillText(cell.caption, left + PAD, stripTop + PAD);
      if (cell.lines.length) {
        ctx.font = font('normal', 24);
        cell.lines.forEach((line, index) => ctx.fillText(line, left + PAD, stripTop + PAD + HEAD + index * LINE));
      } else {
        ctx.fillStyle = '#80868b';
        ctx.font = font('italic', 24);
        ctx.fillText('(no narration)', left + PAD, stripTop + PAD + HEAD);
      }
      ctx.textBaseline = 'alphabetic';
    }
    top += cellH + strip[rowIndex] + GAP;
  }
  return canvas.toDataURL('image/png');
}

export async function makeSheets(slug, slidesRoot) {
  const dir = join(slidesRoot, slug);
  const deck = JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8'));
  const cells = [];
  (Array.isArray(deck.slides) ? deck.slides : []).forEach((slide, slideIndex) => viewsOf(slide).forEach((view, viewIndex, all) =>
    cells.push({ slide, view, caption: `page ${slide.page ?? slideIndex + 1} · part ${viewIndex + 1}/${all.length}` })));
  for (const name of await readdir(dir)) if (/^sheet-\d+\.png$/.test(name)) await rm(join(dir, name), { force: true }); // stale sheets
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath: process.env.ROBOMEET_CHROME_PATH || '/usr/bin/google-chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><title>RoboMeet deck sheet</title>');
    const files = [];
    for (let start = 0; start < cells.length; start += PER_SHEET) {
      const group = await Promise.all(cells.slice(start, start + PER_SHEET).map(cell => cellFor(cell, slidesRoot)));
      const url = await page.evaluate(drawSheet, { cells: group, cellW: CELL_W, cellH: CELL_H });
      const file = join(dir, `sheet-${files.length + 1}.png`);
      await writeFile(file, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
      files.push(file);
    }
    return files;
  } finally {
    await browser.close();
  }
}

// ---- main
async function main() {
  const { values: options, positionals } = parseArgs({ allowPositionals: true, options: {
    slug: { type: 'string' }, title: { type: 'string' }, fit: { type: 'string' }, 'page-width': { type: 'string', default: '2400' }, 'max-pages': { type: 'string' }, 'slides-root': { type: 'string' },
  } });
  const [command, target] = positionals;
  if (!['build', 'sheet', 'check'].includes(command) || !target || (options.fit !== undefined && !['page', 'width'].includes(options.fit))) { console.error(USAGE); process.exit(1); }
  const slidesRoot = resolve(options['slides-root'] || fileURLToPath(new URL('../public/slides', import.meta.url)));
  if (command === 'build') {
    // --slug is cleaned like a file-name slug (letters and digits, '-' between) and must then be a slug the server
    // presents (present_deck refuses others): checked before any work.
    const cleaned = options.slug === undefined ? undefined : options.slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (cleaned !== undefined && !DECK_SLUG.test(cleaned)) { console.error(`Invalid --slug ${JSON.stringify(options.slug)}: a deck slug is 1-81 letters a-z, digits and '-', starting with a letter or digit`); process.exit(1); }
    const maxPages = options['max-pages'] === undefined ? 60 : Number(options['max-pages']);
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 200) { console.error(`--max-pages must be a whole number from 1 to 200, not ${options['max-pages']}`); process.exit(1); }
    const slug = cleaned ?? await deckSlug(slidesRoot, target);
    const deck = await buildDeck(target, { slidesRoot, slug, title: options.title, fit: options.fit, pageWidth: Number(options['page-width']) || 2400, maxPages });
    if (deck.truncated) console.error(`Warning: ${deck.truncated.message}${deck.truncated.reason === 'maxPages' && maxPages < 200 ? ' Build again with --max-pages N (up to 200) to include more.' : ''}`);
    console.log(JSON.stringify({ slug: deck.slug, title: deck.title, pages: deck.pages, viewsPerPage: deck.slides.map(slide => slide.views.length), deck: join(deck.dir, 'deck.json'), ...(deck.truncated ? { truncated: deck.truncated } : {}) }, null, 2));
    return;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(target) || /^\.+$/.test(target)) { console.error(`Not a deck slug: ${target}`); process.exit(1); }
  if (command === 'sheet') { console.log((await makeSheets(target, slidesRoot)).join('\n')); return; }
  console.log(JSON.stringify(checkDeck(JSON.parse(await readFile(join(slidesRoot, target, 'deck.json'), 'utf8'))), null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error?.message || error); process.exit(2); });
}
