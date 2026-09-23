// The meeting page's signals, from the audio bridge instead of a browser. One job: tell the store what the page would.
//
// In a real meeting src/meet-stage.js reports the robot's own speech ('stage-speech' onset/end, end after 800 ms of
// silence), what it hears from the room ('stage-input' onset/end, end after 700 ms), and src/stage-sync.mjs reports
// each screen position once it is shown ('stage-shown'). The presenter and the late-result delivery read exactly
// these events. Headless, the pacer knows who is on air every 100 ms, so it can report the same events with the
// same timing, and the real presenter runs unchanged.
const SPEECH_END_MS = 800; // meet-stage.js tune.speechEndMs
const INPUT_END_MS = 700;  // meet-stage.js INPUT_END_MS

export function startRoomSignals({ store, pacer, everyMs = 50 }) {
  const speech = { on: false, lastOn: 0 }, input = { on: false, lastOn: 0 };
  let shownAt = null;
  const timer = setInterval(() => {
    const now = Date.now();
    const robotOn = pacer.speaking('a'), alexOn = pacer.speaking('b');
    if (robotOn) { if (!speech.on) { speech.on = true; store.event('stage-speech', { phase: 'onset', at: now, slide: store.state.slideIndex, view: store.state.viewIndex }); } speech.lastOn = now; }
    else if (speech.on && now - speech.lastOn >= SPEECH_END_MS) { speech.on = false; store.event('stage-speech', { phase: 'end', at: speech.lastOn, slide: store.state.slideIndex, view: store.state.viewIndex }); }
    if (alexOn) { if (!input.on) { input.on = true; store.event('stage-input', { phase: 'onset', at: now }); } input.lastOn = now; }
    else if (input.on && now - input.lastOn >= INPUT_END_MS) { input.on = false; store.event('stage-input', { phase: 'end', at: input.lastOn }); }
    const where = `${store.state.slideIndex}:${store.state.viewIndex}:${store.state.slides?.length || 0}`;
    if (where !== shownAt && store.state.slides?.length) { shownAt = where; store.event('stage-shown', { slide: Number(store.state.slideIndex) || 0, view: Number(store.state.viewIndex) || 0, kind: 'image', at: now }); }
  }, everyMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
