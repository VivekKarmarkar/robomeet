// Phrase -> the tightest box around exactly the words of that phrase. src/pointer.mjs aims at whole line boxes, which
// is why asking for "ẏ(0) = v 0 sin θ" boxed "ẋ(0) = v 0 cos θ, ẏ(0) = v 0 sin θ" as well: both components are one
// line. Given the word boxes of a view (src/word-boxes.mjs) this matches the phrase across the word sequence and
// returns the union of the matched words only, plus which words they were, so the caller can say what it boxed.
// Pure: no I/O, no deck reading. One job.
const r4 = value => Math.round(value * 1e4) / 1e4;
// Same normalisation on both sides: NFC (ẏ has a composed and a decomposed spelling), lowercase, unify the dash and
// quote families a PDF renders differently from what a person types, drop the rest of the punctuation noise.
export const norm = text => String(text ?? '').normalize('NFC').toLowerCase()
  .replace(/[‐-―−]/g, '-').replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"')
  .replace(/\s+/g, ' ').trim();
const squash = text => norm(text).replace(/[\s,;:.]/g, '');

// Every [start, end) run of words whose squashed text contains the squashed phrase. Longest-first is not needed:
// the first hit in reading order is the one on screen that a person means.
function runs(words, wanted) {
  const squashed = words.map(word => squash(word.text));
  const out = [];
  for (let start = 0; start < words.length; start++) {
    if (!squashed[start]) continue;
    let joined = '';
    for (let end = start; end < words.length && joined.length < wanted.length + squashed[end].length; end++) {
      joined += squashed[end];
      if (joined === wanted) { out.push([start, end + 1]); break; }
      // A phrase may start or end mid-word ("v0 sin" inside "v" "0" "sin"); accept a run that contains it exactly once
      // and is no more than one word longer on each side.
      if (joined.includes(wanted) && end - start <= wanted.length) { out.push([start, end + 1]); break; }
    }
  }
  return out;
}

const union = boxes => {
  const x0 = Math.min(...boxes.map(b => b.x)), x1 = Math.max(...boxes.map(b => b.x + b.w));
  const y0 = Math.min(...boxes.map(b => b.y)), y1 = Math.max(...boxes.map(b => b.y + b.h));
  return { x: r4(x0), y: r4(y0), w: r4(x1 - x0), h: r4(y1 - y0) };
};

// { rect, words, text } for the tightest match, or null. `words` are the matched word boxes themselves, so a caller
// can report exactly what is inside the box rather than claiming it.
export function findPhrase(words = [], phrase) {
  const wanted = squash(phrase);
  if (!wanted || !words.length) return null;
  const hits = runs(words, wanted);
  if (!hits.length) return null;
  // Prefer the shortest run: the fewest extra words around the phrase.
  const [start, end] = hits.sort((a, b) => (a[1] - a[0]) - (b[1] - b[0]))[0];
  const chosen = words.slice(start, end);
  return { rect: union(chosen), words: chosen, text: chosen.map(word => word.text).join(' ') };
}

// Every word box that lies inside a rectangle, at least `fraction` of its area. This is the oracle side: given the
// rectangle that is actually drawn, it says what is really inside it, which is not always what was asked for.
export function wordsInside(words = [], rect, fraction = 0.5) {
  if (!rect) return [];
  return words.filter(word => {
    const left = Math.max(word.x, rect.x), right = Math.min(word.x + word.w, rect.x + rect.w);
    const top = Math.max(word.y, rect.y), bottom = Math.min(word.y + word.h, rect.y + rect.h);
    if (right <= left || bottom <= top) return false;
    const area = word.w * word.h;
    return area <= 0 || ((right - left) * (bottom - top)) / area >= fraction;
  });
}
