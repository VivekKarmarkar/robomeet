// A phrase on the shared screen -> the box around exactly its words, for the LIVE highlight path.
//
// src/pointer.mjs resolves a phrase against whole line boxes. In live test 7 that made "ẏ(0) = v 0 sin θ" box the
// whole line "ẋ(0) = v 0 cos θ, ẏ(0) = v 0 sin θ", both velocity components. src/fine-pointer.mjs could already find
// the exact words, but only the checks that REPORT on a box used it; the pointer that DRAWS the box never did. This
// is the missing piece: given the deck and a phrase, the word-level rectangle, padded by the same rule pointer.mjs
// uses so the box looks the same. Returns null when words cannot be matched (no word boxes for this deck, or the
// phrase is not literally on screen), so the caller falls back to the line-level pointer. One job.
import { wordsForDeck, wordsInView } from './word-boxes.mjs';
import { findPhrase } from './fine-pointer.mjs';
import { stageMap, DRAW_PAD_PX, STROKE_PX } from './drawn-box.mjs';

const CLEAR_PX = 3; // the stroke's outer edge keeps at least this many canvas px away from any word it is not boxing
const MIN_PX = 4;   // never shrink a side so far that the box has no body
const r4 = value => Math.round(value * 1e4) / 1e4;

// The exact word outline, pulled in on any side where a neighbouring word is closer than the painted frame reaches
// (DRAW_PAD_PX of room plus half the STROKE_PX line, plus CLEAR_PX). So the frame hugs the term and never clips a
// neighbour: in live test 7 the box around "ẏ(0) = v 0 sin θ" cut through the "θ," of the cosine term beside it.
export function tightRect(union, others, view, asset = { width: 1920, height: 1080 }) {
  const map = stageMap({ rect: view, asset });
  const reachX = (DRAW_PAD_PX + STROKE_PX / 2 + CLEAR_PX) / map.sx, reachY = (DRAW_PAD_PX + STROKE_PX / 2 + CLEAR_PX) / map.sy;
  let x0 = union.x, x1 = union.x + union.w, y0 = union.y, y1 = union.y + union.h;
  const overlapsY = o => o.y < y1 && o.y + o.h > y0, overlapsX = o => o.x < x1 && o.x + o.w > x0;
  let left = reachX, right = reachX, top = reachY, bottom = reachY;
  for (const o of others) {
    if (overlapsY(o) && o.x + o.w <= x0) left = Math.min(left, x0 - (o.x + o.w));
    if (overlapsY(o) && o.x >= x1) right = Math.min(right, o.x - x1);
    if (overlapsX(o) && o.y + o.h <= y0) top = Math.min(top, y0 - (o.y + o.h));
    if (overlapsX(o) && o.y >= y1) bottom = Math.min(bottom, o.y - y1);
  }
  // A side whose neighbour is inside the frame's reach is inset by the shortfall, so the painted edge lands short of it,
  // but never so far that the stroke crosses the asked words themselves: at most DRAW_PAD_PX - STROKE_PX / 2, where the
  // stroke's inner edge meets the words. When the gap is too small for both (the "," 2 px after "45°"), the frame
  // touches the neighbour rather than cutting the thing that was asked for (2026-09-22: it cut the degree sign).
  const maxInX = (DRAW_PAD_PX - STROKE_PX / 2) / map.sx, maxInY = (DRAW_PAD_PX - STROKE_PX / 2) / map.sy;
  x0 += Math.min(maxInX, Math.max(0, reachX - left)); x1 -= Math.min(maxInX, Math.max(0, reachX - right));
  y0 += Math.min(maxInY, Math.max(0, reachY - top)); y1 -= Math.min(maxInY, Math.max(0, reachY - bottom));
  const minW = MIN_PX / map.sx, minH = MIN_PX / map.sy;
  if (x1 - x0 < minW) { const c = (x0 + x1) / 2; x0 = c - minW / 2; x1 = c + minW / 2; }
  if (y1 - y0 < minH) { const c = (y0 + y1) / 2; y0 = c - minH / 2; y1 = c + minH / 2; }
  return { x: r4(x0), y: r4(y0), w: r4(x1 - x0), h: r4(y1 - y0) };
}

// A PDF word carries its punctuation ("θ," is one word), so boxing "ẋ(0) = v 0 cos θ" took in the comma. A comma,
// full stop, colon or semicolon at either end that the request did not include is trimmed off, by that word's share
// of characters (a word box has no per-character positions; its glyphs are close to evenly spaced).
const EDGE = /[,.;:]+$/, LEAD = /^[,.;:]+/;
export function trimPunctuation(hit, phrase) {
  const words = hit.words; if (!words?.length) return hit.rect;
  const asked = String(phrase).trim();
  let x0 = hit.rect.x, x1 = hit.rect.x + hit.rect.w;
  const last = words.at(-1), first = words[0];
  const tail = (last.text.match(EDGE) || [''])[0];
  if (tail && !asked.endsWith(tail) && last.text.length > tail.length) x1 = Math.min(x1, last.x + last.w * (1 - tail.length / last.text.length));
  const lead = (first.text.match(LEAD) || [''])[0];
  if (lead && !asked.startsWith(lead) && first.text.length > lead.length) x0 = Math.max(x0, first.x + first.w * (lead.length / first.text.length));
  return { ...hit.rect, x: x0, w: x1 - x0 };
}

// { rect, how: 'words', text } or null.
export async function wordPointer({ publicDir, slug, slideIndex = 0, slide, view, phrase }) {
  const wanted = String(phrase ?? '').trim();
  if (!wanted || !view || !slug) return null;
  const words = await wordsForDeck(publicDir, slug).catch(() => null);
  const page = Number(slide?.page) || Number(slideIndex) + 1;
  const pageWords = words?.pages?.[page - 1]?.words;
  if (!pageWords?.length) return null;
  const inView = wordsInView(pageWords, view);
  const hit = findPhrase(inView, wanted);
  if (!hit) return null;
  const others = inView.filter(w => !hit.words.includes(w));
  return { rect: tightRect(trimPunctuation(hit, wanted), others, view), how: 'words', text: hit.text };
}
