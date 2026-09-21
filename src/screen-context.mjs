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
    return text ? `On your shared screen now: ${where}. It shows: ${text.slice(0, MAX)}` : `On your shared screen now: ${where}. RoboMeet has no text for this part; describe only what you are told.`;
  }
  // [line n] labels: parentheses would read like the document's own equation numbers.
  const numbered = lines.map((line, i) => `[line ${i + 1}] ${line}`).join(' ');
  const pointer = view?.highlight && state.pointer ? ' An amber box is drawn on part of it.' : '';
  return `On your shared screen now: ${where}. The visible text, line by line from the top, exactly as written: ${numbered}`.slice(0, MAX) + pointer + ' Refer to lines exactly as listed; never place something on a line it is not on.';
}

// Sends viewText whenever the position changes while a voice session is live. The presenter sends its own.
export function watchScreen({ store, live, debounceMs = 300 }) {
  let last = null, timer = null;
  const send = () => {
    timer = null;
    const state = store.state;
    const key = `${state.deckSlug || state.title}|${state.slideIndex}|${state.viewIndex}|${state.slides?.length}`;
    if (key === last) return;
    if (!state.meeting?.sharing || state.presenter?.status === 'running' || !live.activeSession?.()) return;
    const text = viewText(state);
    if (!text) return;
    if (live.context?.(text, false, { replay: false }) !== false) last = key;
  };
  const onChange = () => { if (!timer) timer = setTimeout(send, debounceMs); };
  store.on('change', onChange);
  return () => { clearTimeout(timer); store.off('change', onChange); };
}
