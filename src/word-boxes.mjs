// Word-level boxes for a built deck. The deck's own line boxes are the finest thing the pointer can aim at today, so
// a phrase that is half of a line ("ẏ(0) = v 0 sin θ" inside "ẋ(0) = v 0 cos θ, ẏ(0) = v 0 sin θ") can only be boxed
// by boxing the whole line. pdftotext -bbox-layout already reports every word's box; deck-builder's parser keeps the
// word text and drops its coordinates. This reads the same output and keeps the coordinates, page-normalized exactly
// as deck-formats does, cached next to the deck as words.json. It reads; it never writes a deck.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const r4 = value => Math.round(value * 1e4) / 1e4;
const attr = (tag, name) => Number((tag.match(new RegExp(`${name}="([-\\d.]+)"`)) || [])[1]);
const unescape = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// [{ page, words: [{ text, x, y, w, h }] }] in page-normalized units, one entry per page, in page order.
export function parseWordBoxes(xhtml) {
  const pages = [];
  for (const pageMatch of xhtml.matchAll(/<page\b[^>]*>([\s\S]*?)<\/page>/g)) {
    const pageTag = pageMatch[0].slice(0, pageMatch[0].indexOf('>') + 1);
    const width = attr(pageTag, 'width'), height = attr(pageTag, 'height');
    const words = [];
    for (const wordMatch of pageMatch[1].matchAll(/<word\b([^>]*)>([\s\S]*?)<\/word>/g)) {
      const tag = wordMatch[1];
      const x0 = attr(tag, 'xMin'), y0 = attr(tag, 'yMin'), x1 = attr(tag, 'xMax'), y1 = attr(tag, 'yMax');
      const text = unescape(wordMatch[2]).trim();
      if (!text || ![x0, y0, x1, y1, width, height].every(Number.isFinite) || x1 <= x0 || y1 <= y0) continue;
      words.push({ text, x: r4(x0 / width), y: r4(y0 / height), w: r4((x1 - x0) / width), h: r4((y1 - y0) / height) });
    }
    pages.push({ width, height, words });
  }
  return pages;
}

// Page-order word boxes for a PDF. maxPages matches the deck build so page indexes line up.
export async function wordBoxesForPdf(pdfPath, maxPages = 60) {
  const { stdout } = await run('pdftotext', ['-bbox-layout', '-l', String(maxPages), pdfPath, '-'], { maxBuffer: 512 << 20 });
  return parseWordBoxes(stdout);
}

// Words for a deck, cached as words.json beside deck.json. Returns { pages: [{ words }] } or null when the deck's
// source is not a readable local PDF (a web page or a picture deck has no pdftotext to ask).
export async function wordsForDeck(publicDir, slug, { rebuild = false } = {}) {
  const dir = join(publicDir, 'slides', slug);
  if (!rebuild) {
    try { return JSON.parse(await readFile(join(dir, 'words.json'), 'utf8')); } catch {}
  }
  let deck;
  try { deck = JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8')); } catch { return null; }
  const source = typeof deck.source === 'string' ? deck.source : '';
  if (!source.toLowerCase().endsWith('.pdf')) return null;
  let pages;
  try { pages = await wordBoxesForPdf(source, Math.max(1, deck.pages || deck.slides?.length || 1)); } catch { return null; }
  const built = { slug, source, pages };
  try { await writeFile(join(dir, 'words.json'), JSON.stringify(built)); } catch {}
  return built;
}

// The words of one slide, in reading order, filtered to those at least half inside the view rectangle.
export function wordsInView(words = [], view) {
  if (!view) return words;
  const vx = Number.isFinite(view.x) ? view.x : 0, vy = Number.isFinite(view.y) ? view.y : 0;
  const vw = Number.isFinite(view.w) ? view.w : 1, vh = Number.isFinite(view.h) ? view.h : 1;
  return words.filter(word => {
    const top = Math.max(word.y, vy), bottom = Math.min(word.y + word.h, vy + vh);
    return bottom - top >= word.h / 2 && word.x < vx + vw && word.x + word.w > vx;
  });
}
