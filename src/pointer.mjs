// P3 (docs/problems/presenting-v1.md): a pointer. The robot (point_at) or the coding session (highlight) names a
// phrase, an equation number or a rectangle; this resolves it to a page-normalized box on the view that is on screen,
// using the line boxes deck-builder stored in deck.json. The box is drawn by the stage's existing highlight.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { highlightFor } from './deck-builder.mjs';

const hasBox = line => line && typeof line === 'object' && [line.x, line.y, line.w, line.h].every(Number.isFinite);
const r4 = value => Math.round(value * 1e4) / 1e4;
// Padding in screen pixels, converted per view: a page-height fraction pads a tall web page by 50 px or more.
const PAD_PX = 8;

// Every line box of a slide (views overlap, so lines repeat).
export function slideLines(slide) {
  const seen = new Set(), out = [];
  for (const view of slide?.views || []) for (const line of view.lines || []) {
    if (!hasBox(line)) continue;
    const key = `${line.text}|${line.x}|${line.y}`;
    if (!seen.has(key)) { seen.add(key); out.push(line); }
  }
  return out;
}
// Lines at least half inside the view rectangle.
function inView(lines, view) {
  return lines.filter(line => {
    const top = Math.max(line.y, view.y), bottom = Math.min(line.y + line.h, view.y + view.h);
    return bottom - top >= line.h / 2 && line.x < view.x + view.w && line.x + line.w > view.x;
  });
}
const union = (lines, view) => {
  const padX = view.w * PAD_PX / 1920, padY = view.h * PAD_PX / 1080;
  const x0 = Math.min(...lines.map(l => l.x)), x1 = Math.max(...lines.map(l => l.x + l.w));
  const y0 = Math.min(...lines.map(l => l.y)), y1 = Math.max(...lines.map(l => l.y + l.h));
  const left = Math.max(view.x, x0 - padX), right = Math.min(view.x + view.w, x1 + padX);
  const top = Math.max(view.y, y0 - padY), bottom = Math.min(view.y + view.h, y1 + padY);
  return { x: r4(left), y: r4(top), w: r4(right - left), h: r4(bottom - top) };
};
// "(3)", "3", "equation 3", "eq. (3)" -> "3"
export function equationNumber(text) {
  const match = /^\s*(?:eq(?:uation)?\.?\s*)?\(?\s*(\d{1,3}[a-z]?)\s*\)?\s*$/i.exec(String(text ?? ''));
  return match ? match[1] : null;
}
// The whole row of an equation: every line that shares the vertical band of its "(n)" label.
function equationRow(lines, number) {
  const label = lines.find(line => line.text.replace(/\s/g, '') === `(${number})`);
  if (!label) return null;
  const mid = label.y + label.h / 2;
  const row = lines.filter(line => line !== label && line.y - 0.004 <= mid && line.y + line.h + 0.004 >= mid);
  return row.length ? [...row, label] : [label];
}

// request: { phrase } | { equation } | { x, y, w, h }. Returns { rect, how } or { error }.
export function resolvePointer({ slide, view, request }) {
  if (!view) return { error: 'No view is on screen.' };
  const area = { x: view.x ?? 0, y: view.y ?? 0, w: view.w ?? 1, h: view.h ?? 1 };
  if (['x', 'y', 'w', 'h'].every(key => Number.isFinite(Number(request?.[key])))) {
    const rect = { x: Number(request.x), y: Number(request.y), w: Number(request.w), h: Number(request.h) };
    if (rect.w <= 0 || rect.h <= 0) return { error: 'The rectangle is empty.' };
    return { rect, how: 'rect' };
  }
  const lines = inView(slideLines(slide), area);
  if (!lines.length) return { error: 'This view has no text positions, so a phrase cannot be located; give a rectangle.' };
  const number = equationNumber(request?.equation ?? request?.phrase);
  if (number) {
    const row = equationRow(lines, number);
    if (row) return { rect: union(row, area), how: 'equation' };
    if (request?.equation) return { error: `Equation (${number}) is not on screen.` };
  }
  const phrase = String(request?.phrase ?? '').trim();
  if (!phrase) return { error: 'Give a phrase, an equation number or a rectangle.' };
  const found = highlightFor({ ...area, lines }, phrase);
  if (!found) return { error: `"${phrase.slice(0, 80)}" is not on screen.` };
  // The matched lines (their centres inside highlightFor's padded box), boxed again with screen-scaled padding.
  const matched = lines.filter(l => { const cx = l.x + l.w / 2, cy = l.y + l.h / 2; return cx >= found.x && cx <= found.x + found.w && cy >= found.y && cy <= found.y + found.h; });
  return { rect: matched.length ? union(matched, area) : found, how: 'phrase' };
}

export async function readDeck(publicDir, slug) {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,80}$/.test(slug)) return null;
  try { return JSON.parse(await readFile(join(publicDir, 'slides', slug, 'deck.json'), 'utf8')); } catch { return null; }
}
