// What a person means by "scroll down a bit", as a concrete place on the deck.
//
// The stage is addressed by {slide, view}: a PDF page is a slide, and each screen-sized band of it is a view. Nobody
// says that out loud. They say "next", "back one", "go to the top", "part three", "page two". This turns the spoken
// thing into the pair, and walks across page boundaries the way scrolling does: "next" from the last part of page 1
// lands on the first part of page 2, not nowhere. Pure. One job. No store, no stage, no I/O.
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const num = text => { const t = String(text).trim().toLowerCase(); return /^\d{1,3}$/.test(t) ? Number(t) : WORDS[t] ?? null; };

// Every (slide, view) of the deck in reading order, so relative moves are one index step.
export function positions(slides = []) {
  const out = [];
  slides.forEach((slide, s) => {
    const views = Math.max(1, slide?.views?.length || 1);
    for (let v = 0; v < views; v++) out.push({ slide: s, view: v });
  });
  return out;
}
const sameAt = (list, slide, view) => Math.max(0, list.findIndex(p => p.slide === slide && p.view === view));

// { slide, view, how } or { error }. `target` is what was said; `slideIndex`/`viewIndex` are where the screen is.
export function resolveScroll({ slides = [], slideIndex = 0, viewIndex = 0, target = '' } = {}) {
  const list = positions(slides);
  if (!list.length) return { error: 'Nothing is on the shared screen to scroll.' };
  const here = sameAt(list, Number(slideIndex) || 0, Number(viewIndex) || 0);
  const said = String(target ?? '').trim().toLowerCase().replace(/[.!?]+$/, '');
  if (!said) return { error: 'Say where to scroll: next, back, the top, the end, or a part or page number.' };

  const step = (delta, how) => {
    const to = here + delta;
    if (to < 0) return { error: 'The screen is already at the top of the document.' };
    if (to >= list.length) return { error: 'The screen is already at the end of the document.' };
    return { ...list[to], how };
  };
  // "down two", "back 3", "next couple"
  const many = /(?:^|\s)(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|couple|few)(?:\s|$)/.exec(said);
  const count = many ? (many[1] === 'couple' ? 2 : many[1] === 'few' ? 3 : num(many[1]) ?? 1) : 1;

  if (/^(first|top|beginning|start|the top|the beginning|back to the top|all the way up)$/.test(said)) return { ...list[0], how: 'first' };
  if (/^(last|end|bottom|the end|the bottom|all the way down)$/.test(said)) return { ...list.at(-1), how: 'last' };
  // A page or a part, named. "page 2 part 3" resolves both.
  const page = /\bpage\s*(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)\b/.exec(said);
  const part = /\b(?:part|section|band|screen)\s*(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)\b/.exec(said);
  if (page || part) {
    const slide = page ? (num(page[1]) ?? 0) - 1 : Number(slideIndex) || 0;
    if (!slides[slide]) return { error: `There is no page ${page ? num(page[1]) : slide + 1}; the document has ${slides.length}.` };
    const views = Math.max(1, slides[slide].views?.length || 1);
    const view = part ? (num(part[1]) ?? 0) - 1 : 0;
    if (view < 0 || view >= views) return { error: `Page ${slide + 1} has ${views} part${views === 1 ? '' : 's'}.` };
    return { slide, view, how: page && part ? 'page-part' : page ? 'page' : 'part' };
  }
  if (/\b(next|down|forward|further|onward|after|continue|more)\b/.test(said)) return step(count, 'next');
  if (/\b(previous|prev|back|up|before|earlier|return)\b/.test(said)) return step(-count, 'previous');
  // A bare number means a part of the current page: "three" -> part 3.
  const bare = num(said);
  if (bare !== null) {
    const views = Math.max(1, slides[Number(slideIndex) || 0]?.views?.length || 1);
    if (bare < 1 || bare > views) return { error: `This page has ${views} part${views === 1 ? '' : 's'}.` };
    return { slide: Number(slideIndex) || 0, view: bare - 1, how: 'part' };
  }
  return { error: `"${said.slice(0, 40)}" is not a place on the document. Say next, back, the top, the end, or a part or page number.` };
}
