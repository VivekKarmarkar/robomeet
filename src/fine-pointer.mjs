// Phrase -> the tightest box around exactly the words of that phrase. src/pointer.mjs aims at whole line boxes, which
// is why asking for "ẏ(0) = v 0 sin θ" boxed "ẋ(0) = v 0 cos θ, ẏ(0) = v 0 sin θ" as well: both components are one
// line. Given the word boxes of a view (src/word-boxes.mjs) this matches the phrase across the word sequence and
// returns the union of the matched words only, plus which words they were, so the caller can say what it boxed.
// Pure: no I/O, no deck reading. One job.
const r4 = value => Math.round(value * 1e4) / 1e4;
// Same normalisation on both sides: NFKC, lowercase, unify the dash and quote families a PDF renders differently from
// what a person types, drop the rest of the punctuation noise. NFKC rather than NFC because models write maths with
// typographic characters and the PDF extractor emits plain ones: a live run asked to box "ẏ(0) = v₀ sin θ" and the
// page says "v 0", so NFC never matched and the pointer fell back to boxing the whole line. NFKC folds subscript
// and superscript digits (₀ -> 0, ² -> 2) and ligatures, and still keeps ẏ composed.
export const norm = text => String(text ?? '').normalize('NFKC').toLowerCase()
  .replace(/[‐-―−]/g, '-').replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"')
  .replace(/[◦∘˚]/g, '°') // the PDF sets a degree as U+25E6 "◦"; people and models write "°"
  .replace(/\s+/g, ' ').trim();
// A stacked fraction has no "/" glyph in the PDF ("T = 2v 0 sin θ" over "g"), and a model writes "/(2g)" where the page
// shows 2g under a bar, so fraction slashes and grouping parentheses are ignored on both sides, like spaces.
const squash = text => norm(text).replace(/[\s,;:.\/\u2044()]/g, ''); // \u2044: NFKC turns ½ into 1⁄2

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
  return out.map(([start, end]) => words.slice(start, end));
}

// The fallback when no contiguous run matches: the PDF does not emit a displayed formula in reading order. For
// "H = v0² sin²θ / 2g" it emits the fraction's numerator and denominator first, then other lines, and "H =" last.
// So the words are grouped into visual lines (a fraction's numerator and denominator sit on their formula's line),
// and on each line the smallest left-to-right span whose characters are exactly the phrase's characters is taken.
// Order-free on purpose: within one span of one line, the same characters are the same formula.
const tally = text => { const m = new Map(); for (const ch of text) m.set(ch, (m.get(ch) || 0) + 1); return m; };
const sameTally = (a, b) => a.size === b.size && [...a].every(([ch, n]) => b.get(ch) === n);
function visualLines(words) {
  const centre = word => word.y + word.h / 2;
  const sorted = [...words].sort((a, b) => centre(a) - centre(b));
  const lines = [];
  for (const word of sorted) {
    const line = lines.at(-1);
    // A gap between centres of more than 0.9 of a text height starts a new line; numerator, denominator,
    // sub- and superscripts stay closer than that to their formula.
    if (line && centre(word) - line.last <= Math.max(0.009, 0.9 * word.h)) { line.words.push(word); line.last = centre(word); }
    else lines.push({ words: [word], last: centre(word) });
  }
  return lines.map(line => line.words.sort((a, b) => a.x - b.x));
}
function lineSpans(words, wanted) {
  const want = tally(wanted), out = [];
  for (const line of visualLines(words)) {
    for (let i = 0; i < line.length; i++) {
      if (!squash(line[i].text)) continue;
      for (let j = i; j < line.length; j++) {
        const right = Math.max(...line.slice(i, j + 1).map(w => w.x + w.w));
        const span = line.filter(w => w.x >= line[i].x && w.x + w.w / 2 <= right);
        const text = span.map(w => squash(w.text)).join('');
        if (text.length > wanted.length) break;
        if (text.length === wanted.length && sameTally(tally(text), want)) { out.push(span); break; }
      }
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
  let hits = runs(words, wanted);
  if (!hits.length) hits = lineSpans(words, wanted);
  if (!hits.length) return null;
  // Prefer the shortest run: the fewest extra words around the phrase.
  const chosen = hits.sort((a, b) => a.length - b.length)[0];
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
