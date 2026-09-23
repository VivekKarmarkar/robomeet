// A real-time video feed of the shared screen, encoded in GPT Live's native format.
//
// GPT Live takes audio and text. Its model card: "Unsupported modalities: image, video". So a video feed into it
// cannot be pixels; it has to be text. This is that feed: a frame loop that samples the screen state at a frame
// rate, encodes each frame as a compact line of text, and sends only what CHANGED since the last frame. That is
// what a video codec does - keyframe, then deltas - and it is why the feed stays inside the 500-token-per-append
// cap while still being continuous.
//
// It is a feed, not an event: it runs at a frame rate whether or not anything is drawn, so the robot always knows
// what is on screen NOW rather than what was true when something last happened. Encoding a frame is pure string
// work over state we already hold, which is why it costs microseconds rather than the ~6 s a picture costs.
import { wordsInView } from './word-boxes.mjs';
import { wordsInside } from './fine-pointer.mjs';
import { paintedBox } from './drawn-box.mjs';

export const DEFAULT_FPS = 10;        // 100 ms between samples; the screen cannot change faster than a human moves it
// No periodic resend of an unchanged screen: OpenAI's guidance for UI context is to skip unchanged updates, and in the
// 2026-09-22 honest-tester runs the robot read the repeated SCREEN lines aloud. Appends are acknowledged, so a delta
// is not silently lost; the first frame of a feed is still a full keyframe. A caller may still pass keyframeMs.
export const KEYFRAME_MS = Infinity;
const MAX_FRAME = 440;                // characters; live.mjs chunks context at 450 and the cap is 500 tokens
const FOR_YOU = ' (For you, not to read out.)'; // the robot recited these lines aloud when they were bare facts
const SHOWS_MAX = 260;                // characters of the visible-terms index

// The headings and labels visible in a view, as a short index. The behavioural loop caught why this is needed: with
// only a position, "is the range formula on screen?" was unanswerable even standing on the part that shows it, and
// an honest "I have not been shown" reads as a refusal of something true. This is not the full line dump (that is
// P4's channel, two thousand characters on every move); it is the short, distinctive lines — headings, equation
// labels, section titles — which is what people actually ask about. It rides on view changes and keyframes only,
// never on every frame, so deltas stay small.
function showsIndex(view) {
  const lines = (view?.lines || []).map(line => String(typeof line === 'string' ? line : line?.text || '').trim()).filter(Boolean);
  const picked = [];
  for (const line of lines) {
    if (line.length > 42) continue;             // a paragraph is not a landmark
    if (/^\d{1,3}$/.test(line)) continue;       // a bare page or section number
    if (picked.includes(line)) continue;
    picked.push(line);
    if (picked.join(', ').length > SHOWS_MAX) break;
  }
  return picked.join(', ').slice(0, SHOWS_MAX);
}

const clip = (text, max) => { const t = String(text || '').trim(); return t.length <= max ? t : `${t.slice(0, max - 1)}…`; };

// The screen as one value. Everything the robot could be asked about, and nothing it cannot check.
export function sampleScreen(state = {}, words = null) {
  const slideIndex = Number(state.slideIndex) || 0, viewIndex = Number(state.viewIndex) || 0;
  const slide = state.slides?.[slideIndex];
  if (!state.meeting?.sharing || !slide) return { sharing: false };
  const views = Array.isArray(slide.views) && slide.views.length ? slide.views : null;
  const view = views ? views[Math.min(viewIndex, views.length - 1)] : null;
  const pointer = state.pointer;
  const onThisView = pointer && pointer.slide === slideIndex && pointer.view === viewIndex;
  const box = onThisView ? view?.highlight : null;
  let inside = null;
  if (box && words && view) {
    const page = Number(slide.page) || slideIndex + 1;
    const painted = paintedBox({ rect: view, box, asset: view.asset ? { width: 1920, height: 1080 } : null });
    inside = wordsInside(wordsInView(words.pages?.[page - 1]?.words || [], view), painted, 0.5).map(word => word.text).join(' ');
  }
  return {
    sharing: true,
    title: clip(state.title || 'the deck', 60),
    page: slideIndex + 1,
    pages: state.slides.length,
    part: views ? Math.min(viewIndex, views.length - 1) + 1 : 1,
    parts: views ? views.length : 1,
    moving: state.presenter?.status === 'running',
    shows: showsIndex(view),
    box: box ? (inside === null ? 'unverifiable' : inside || 'nothing') : null,
  };
}

// One frame of the feed. `previous` null means a keyframe: the whole state. Otherwise only what changed.
export function encodeFrame(now, previous) {
  if (!now.sharing) return previous?.sharing === false ? null : `SCREEN: you are not sharing anything.${FOR_YOU}`;
  const where = `${now.title}, page ${now.page} of ${now.pages}, part ${now.part} of ${now.parts}`;
  const boxText = now.box === null ? 'no box is drawn'
    : now.box === 'unverifiable' ? 'a box is drawn but RoboMeet cannot check what is in it, so claim nothing about it'
    : now.box === 'nothing' ? 'a box is drawn around nothing'
    : `the box contains exactly "${clip(now.box, 200)}" and nothing else`;
  const shows = now.shows ? ` It shows: ${now.shows}.` : '';
  if (!previous || !previous.sharing) return clip(`SCREEN: ${where}; ${boxText}.${shows}`, MAX_FRAME - FOR_YOU.length) + FOR_YOU;
  const changed = [];
  const moved = previous.page !== now.page || previous.part !== now.part || previous.title !== now.title;
  if (moved) changed.push(`now on ${where}`);
  if (previous.box !== now.box) changed.push(boxText);
  if (!changed.length) return null; // nothing moved: send nothing, the way a codec drops an identical frame
  // The index rides on a move, because that is when what is visible changed. A box appearing does not change it.
  return clip(`SCREEN: ${changed.join('; ')}.${moved ? shows : ''}`, MAX_FRAME - FOR_YOU.length) + FOR_YOU;
}

// Run the feed. Returns { stop, stats } — stats carries the measured per-frame encode cost, so "milliseconds" is a
// number this thing reports about itself rather than a claim about it.
export function startScreenFeed({ store, live, wordsFor = async () => null, fps = DEFAULT_FPS, keyframeMs = KEYFRAME_MS, now = () => Date.now() }) {
  let previous = null, lastSentAt = 0, words = null, slug = null, busy = false;
  const stats = { frames: 0, sent: 0, dropped: 0, encodeUs: 0, maxEncodeUs: 0 };
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const state = store.state;
      if (state.deckSlug !== slug) { slug = state.deckSlug; words = await wordsFor(slug); }
      const started = process.hrtime.bigint();
      const sample = sampleScreen(state, words);
      const keyframe = now() - lastSentAt >= keyframeMs;
      const frame = encodeFrame(sample, keyframe ? null : previous);
      const micros = Number(process.hrtime.bigint() - started) / 1000;
      stats.frames++;
      stats.encodeUs += micros;
      if (micros > stats.maxEncodeUs) stats.maxEncodeUs = micros;
      if (!frame) { stats.dropped++; previous = sample; return; }
      if (!live.activeSession?.()) { previous = sample; return; }
      if (live.context?.(frame, false, { replay: false }) !== false) { stats.sent++; lastSentAt = now(); }
      previous = sample;
    } catch { /* a feed must never throw into the interval */ }
    finally { busy = false; }
  };
  const timer = setInterval(tick, Math.max(20, Math.round(1000 / fps)));
  timer.unref?.();
  return { stop: () => clearInterval(timer), stats, tick };
}
