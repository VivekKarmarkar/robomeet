// P4 (docs/problems/presenting-v1.md): the robot must know exactly what is on its shared screen. In test 6 it got a
// 350-character clip and placed an equation on the wrong line. This builds the full visible text of the view on
// screen, line by line, and sends it as quiet context on every move (narrated moves are sent by the presenter with the
// same text).
const MAX = 4000; // context() chunks it under the per-append token limit

export function viewText(state = {}) {
  const slideIndex = Number(state.slideIndex) || 0, viewIndex = Number(state.viewIndex) || 0;
  const slide = state.slides?.[slideIndex];
  if (!slide) return null;
  const views = Array.isArray(slide.views) && slide.views.length ? slide.views : null;
  const view = views ? views[Math.min(viewIndex, views.length - 1)] : null;
  const lines = (view?.lines || []).map(line => String(typeof line === 'string' ? line : line?.text || '').trim()).filter(Boolean);
  const where = `${String(state.title || 'the deck').trim()}, page ${slideIndex + 1}${views ? `, part ${Math.min(viewIndex, views.length - 1) + 1} of ${views.length}` : ''}`;
  if (!lines.length) {
    const body = typeof slide.body === 'string' && !slide.body.startsWith('image:') ? slide.body : '';
    const text = [slide.title, body].filter(Boolean).join('. ');
    return text ? `On your shared screen now: ${where}. It shows: ${text.slice(0, MAX)} (For you, not to read out.)` : `On your shared screen now: ${where}. RoboMeet has no text for this part; describe only what you are told. (For you, not to read out.)`;
  }
  // [line n] labels: parentheses would read like the document's own equation numbers.
  const numbered = lines.map((line, i) => `[line ${i + 1}] ${line}`).join(' ');
  const pointer = view?.highlight && state.pointer ? ' An amber box is drawn on part of it.' : '';
  // The text layer flattens mathematics ("v 0 2 sin 2 θ" is v0² sin²θ); src/view-math.mjs read the formulas from the picture.
  const math = Array.isArray(view?.math) && view.math.length ? ` The displayed formulas on this part, written out correctly (trust these over the flattened text above): ${view.math.join('; ')}.` : '';
  return `On your shared screen now: ${where}. The visible text, line by line from the top, exactly as written: ${numbered}`.slice(0, MAX - math.length) + math + pointer + ' Refer to lines exactly as listed; never place something on a line it is not on. This is reference for you, not something to read out: the [line n] labels are not equation numbers, and never mention them, part numbers or the deck name unless asked where you are.';
}

// What each part of the shared deck holds, once: its headings and its formulas written out (src/view-math.mjs), in one
// short note. Measured 2026-09-22 (tools/sim-participant/tool-probe.mjs, recite-probe.mjs): the full text of a part
// sent on every move made the robot narrate the part unasked when it arrived in silence (4/4 moves), and when it
// arrived while someone was asking for something it took over the turn: 2 of 5 plain requests got their tool on time,
// against 5 of 5 with no text on the move. So the content goes once, when the deck is shared, and a move is reported
// by the short SCREEN feed alone.
const headingsOf = view => (view?.lines || []).map(line => String(typeof line === 'string' ? line : line?.text || '').trim())
  .filter(line => line.length <= 36 && /^[A-Z]/.test(line) && /[A-Za-z]{4,}/.test(line) && !/:$/.test(line)).slice(0, 8); // headings, not flattened maths
export function deckMap(state = {}) {
  const parts = [];
  (state.slides || []).forEach((slide, s) => (slide.views?.length ? slide.views : [slide]).forEach((view, v) => {
    const heads = headingsOf(view), math = Array.isArray(view?.math) ? view.math : [];
    if (!heads.length && !math.length) return;
    const label = (state.slides.length > 1 ? `page ${s + 1} ` : '') + (slide.views?.length > 1 ? `part ${v + 1}` : '');
    parts.push(`${label.trim() || `slide ${s + 1}`}: ${heads.join('; ')}${math.length ? `. Formulas: ${math.join('; ')}` : ''}`);
  }));
  if (!parts.length) return null;
  return `What your shared deck "${String(state.title || 'the deck').trim()}" holds, part by part (for you, not to read out; RoboMeet tells you which part is on screen): ${parts.join(' | ')}`.slice(0, MAX);
}

// Sends viewText whenever the position changes while a voice session is live. The presenter sends its own.
//
// untilSpeech: hold the text until someone in the meeting is speaking (the page's 'stage-input' onset). Measured on
// 2026-09-22 (tools/sim-participant/recite-probe.mjs): sent into a quiet room after a move, this text made the robot
// narrate the part unasked after 4 of 4 moves; with nothing sent, 0 of 4. Arriving while a person talks, it is there
// for their question instead of being a cue to present. The short SCREEN feed still reports the move at once.
export function watchScreen({ store, live, debounceMs = 300, untilSpeech = false, mapOnce = false }) {
  let last = null, timer = null, held = null, mapped = null;
  const speaking = () => {
    const events = store.state.events || [];
    for (let i = events.length - 1, seen = 0; i >= 0 && seen < 400; i--, seen++) if (events[i].type === 'stage-input') return events[i].data?.phase === 'onset';
    return false;
  };
  const deliver = () => {
    if (!held || !speaking() || !live.activeSession?.()) return;
    const { key, text } = held; held = null;
    if (live.context?.(text, false, { replay: false }) !== false) last = key;
  };
  const send = () => {
    timer = null;
    const state = store.state;
    const key = `${state.deckSlug || state.title}|${state.slideIndex}|${state.viewIndex}|${state.slides?.length}`;
    if (key === last) return;
    if (!state.meeting?.sharing || state.presenter?.status === 'running' || !live.activeSession?.()) return;
    if (mapOnce) { // the deck's content once per deck; moves are the feed's job
      const deckKey = `${state.deckSlug || state.title}|${state.slides?.length}`;
      if (deckKey === mapped) { last = key; return; }
      const map = deckMap(state);
      if (!map || live.context?.(map, false, { replay: false }) !== false) { mapped = deckKey; last = key; }
      return;
    }
    const text = viewText(state);
    if (!text) return;
    if (untilSpeech) { held = { key, text }; deliver(); return; }
    if (live.context?.(text, false, { replay: false }) !== false) last = key;
  };
  const onChange = () => { if (!timer) timer = setTimeout(send, debounceMs); if (held) deliver(); };
  store.on('change', onChange);
  return () => { clearTimeout(timer); store.off('change', onChange); };
}
