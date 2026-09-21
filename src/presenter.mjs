// Narrated presentation (docs/stage-design.md; spec TC-S1, S2, S4, L3; beat loop from docs/stage-research.md, critique
// ranks 1, 5, 11). Server side. A deck's views may carry `say` (what to tell the room while that view is on the stage);
// the presenter walks those beats in order. Per beat:
//   0. need an active voice session and mode 'speak', else pause;
//   a. wait for quiet: no user transcript delta for quietMs and the robot not mid-utterance (bounded);
//   b. move the stage (store slideIndex/viewIndex, then sync) and tell the model what is on screen;
//   c. cue the voice (live.narrate); retry once if it is not accepted;
//   d. wait for the robot's own speech onset (stage-speech from src/meet-stage.js); re-cue once;
//   e. the beat is done when the robot has finished it (end events + transcript coverage), or by time budget.
// A person talking during a beat, the share stopping, or a voice session restart pauses the walk (the beat repeats on
// resume). It resumes on control('resume') or a short standalone "continue / go on / next ..." from the room.
// Matched on the utterance with punctuation stripped (live: GPT Live transcribed "Okay, continue" as " Okay" and
// ", continue", about 1.2 s apart).
import { viewText } from './screen-context.mjs'; // P4
export const RESUME = /^(?:(?:ok(?:ay)?|yes|yeah|sure|alright|all right|great|thanks|thank you|got it|good)\s+)?(?:please\s+)?(?:continue|go on|carry on|keep going|next(?: slide| part| page)?|resume|go ahead|move on|proceed)(?:\s+please)?$/i;
// The lead-in of a resume phrase, said alone so far ("All right," then ", continue" a chunk later): not yet a question.
export const LEAD_IN = /^(?:ok(?:ay)?|yes|yeah|sure|alright|all right|great|thanks|thank you|got it|good)(?:\s+please)?$/i;
export const cleanUtterance = text => String(text || '').replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
export const TIMING = {
  quietMs: 700, quietMaxMs: 15000,   // a: silence needed before a cue, and the longest wait for it
  robotQuietMs: 1000,                // a (P5): the robot's own audio silent this long before a cue (a breath is ~350 ms; a cue interrupts speech)
  speakingStaleMs: 120000,           // a (P5): an onset without an end counts as speaking this long (test 6: a 25 s answer was ignored at 15 s)
  utteranceQuietMs: 1500,            // a: after someone speaks (not a "continue" that resumed): one utterance arrives in chunks ~1.2 s apart
  retryMs: 1000,                     // c: pause before the one retry of an unaccepted cue
  onsetTimeoutMs: 4000,              // d: cue to speech onset, before the one re-cue
  ownWordsTailMs: 600,               // e: own-words beat ends on an end with no new onset this long (with the 350 ms end detection: 950 ms of silence)
  verbatimTailMs: 1500, coverage: 0.8, // e: verbatim beat ends on an end at >= coverage, else after this tail
  interruptWords: 2, interruptWindowMs: 1500, // f: this many user words within the window pause a beat
  echoRatio: 0.6, echoWindowMs: 20000, // f: a user utterance mostly made of the robot's recent words is echo
  inputLagMs: 4000,                  // f: a transcript counts as a person only with meeting audio this recently (it lags the audio)
  utteranceGapMs: 1800, resumeMaxWords: 5, // resume: an utterance ends after this gap (GPT Live's input transcript arrives in ~1 s chunks); a resume phrase is short
  resumeConfirmMs: 700,              // resume: a matching phrase resumes after this much more silence
  recentSpeechMs: 5000,              // b: someone spoke this recently -> move the screen before the cue, not at its ack
  coveredAfterInterrupt: 0.85,       // after an interruption, a part the robot already covered (nearly all its words) is not presented again
  shownWaitMs: 600,                  // b: once the page reports stage moves, wait this long for this move's report
  tickMs: 50,                        // re-check period for time-based conditions
  budget: text => speechBudgetMs(text), // e: hard cap for one beat's speech
};

export function beatsFrom(state = {}) {
  const beats = [];
  (Array.isArray(state.slides) ? state.slides : []).forEach((slide, slideIndex) => {
    const views = Array.isArray(slide?.views) && slide.views.length ? slide.views : [{ say: slide?.say }];
    views.forEach((view, viewIndex) => {
      const say = String(view?.say || '').trim();
      if (say) beats.push({ slide: slideIndex, view: viewIndex, say });
    });
  });
  return beats;
}
export const wordsIn = text => String(text || '').trim().split(/\s+/).filter(Boolean).length;
// Upper bound for one beat's speech, so a missed end event never stalls the presentation.
export const speechBudgetMs = text => Math.round(4000 + wordsIn(text) * 520);
// Lowercase letter/digit runs; content words (length >= 3, or digits) are what verbatim coverage counts.
export const tokens = text => String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
// Coverage compares words the way a listener would. The robot paraphrases ("sin" for "sine", "2" for "two",
// "eliminate" for "eliminating", "max" for "maximum"; live 2026-09-15 a fully covered part scored 0.75 on exact
// words), so filler words are not counted and words are normalized before matching.
const STOP = new Set('the and then that this these those with from for are was were has have had its into onto than also just very there here which what when where who how can will would should could may might must been being does did not but all any each some such only own same too come comes came give gives gave equals equal get gets got'.split(' '));
const NUMBER = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90', hundred: '100', thousand: '1000' };
const SHORT = { sin: 'sine', cos: 'cosine', tan: 'tangent', max: 'maximum', min: 'minimum', approx: 'approximately', eq: 'equation', eqn: 'equation', vel: 'velocity', accel: 'acceleration' };
export function stem(word) {
  let out = NUMBER[word] ?? SHORT[word] ?? word;
  if (/^\p{N}/u.test(out)) return out;
  for (const suffix of ['ing', 'ed', 'es', 's', 'e']) if (out.length > suffix.length + 3 && out.endsWith(suffix)) { out = out.slice(0, -suffix.length); break; }
  return out;
}
export const contentWords = text => [...new Set(tokens(text).filter(word => (word.length >= 3 || /^\p{N}+$/u.test(word)) && !STOP.has(word)).map(stem))];
export function coverageOf(say, spoken) {
  const wanted = contentWords(say);
  if (!wanted.length) return 1;
  const heard = new Set(tokens(spoken).map(stem));
  return wanted.filter(word => heard.has(word)).length / wanted.length;
}
// Share of an utterance's words that the robot itself said recently (its own voice picked up by a microphone).
export function echoShare(utterance, robotText) {
  const words = tokens(utterance);
  if (!words.length) return 0;
  const said = new Set(tokens(robotText));
  return words.filter(word => said.has(word)).length / words.length;
}
const viewLines = view => (Array.isArray(view?.lines) ? view.lines : []).map(line => String(typeof line === 'string' ? line : line?.text || '').trim()).filter(Boolean);
const clip = (text, max) => text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, '')}...`;
// [0, 1, 2, 4] -> "1 to 3, 5" (1-based part numbers)
function partList(indexes) {
  const sorted = [...indexes].sort((a, b) => a - b).map(index => index + 1), out = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(j > i ? `${sorted[i]} to ${sorted[j]}` : `${sorted[i]}`);
    i = j;
  }
  return out.join(', ') || 'none';
}
const fail = (message, status) => Object.assign(new Error(message), { status });
const STAGE_EVENTS = ['stage-speech', 'stage-sharing', 'stage-shown', 'stage-input'];

// live: narrate(text, { style, screen }) -> { sent, acked, sessionId }, activeSession() -> { id } | null,
// onTranscript(listener) -> unsubscribe, context(text). sync(): pushes store slideIndex/viewIndex to the in-page stage.
export function createPresenter({ store, live, sync = async () => {}, timing = {} }) {
  const T = { ...TIMING, ...timing };
  let run = null, counter = 0, queue = Promise.resolve(), attached = null;
  // What the presenter knows about the room (shared by runs). Marks: { seq, at (page clock), arrived (local clock) }.
  const speech = { speaking: false, seq: 0, onset: null, end: null };
  const shown = { seen: false, slide: null, view: null };
  const input = { seen: false, speaking: false, endAt: 0 }; // meeting audio from the page ('stage-input')
  const user = { lastAt: 0, spokeAt: 0, resumedAt: 0, parts: [], timer: null }; // parts of the current user utterance: { at, text }; spokeAt: last real user speech
  let robot = []; // the robot's own output transcript of the last echoWindowMs: { at, text }

  // Condition waits: every loop wait re-checks on any news (store event, transcript delta, control) or after tickMs.
  const waiters = new Set();
  const poke = () => { for (const wake of [...waiters]) wake(); };
  const nap = ms => new Promise(resolve => {
    const wake = () => { clearTimeout(timer); waiters.delete(wake); resolve(); };
    const timer = setTimeout(wake, Math.max(0, ms));
    waiters.add(wake);
  });

  function observe(event, fromHistory = false) {
    const data = event.data || {};
    if (event.type === 'stage-speech') {
      const mark = { seq: ++speech.seq, at: Number.isFinite(data.at) ? data.at : Date.parse(event.at), arrived: Date.now() };
      if (data.phase === 'onset') { speech.onset = mark; speech.speaking = !fromHistory || Date.now() - mark.at < T.speakingStaleMs; }
      // An end remembers how much of the beat's transcript had arrived: verbatim coverage is judged as of that end, so
      // the next stretch's text (which can reach us before its onset event) never ends the beat early.
      else if (data.phase === 'end') { speech.end = { ...mark, spoken: run?.live?.spoken.length ?? 0 }; speech.speaking = false; }
    } else if (event.type === 'stage-shown') Object.assign(shown, { seen: true, slide: data.slide, view: data.view });
    else if (event.type === 'stage-input') {
      const at = Number.isFinite(data.at) ? data.at : Date.parse(event.at);
      Object.assign(input, { seen: true, speaking: data.phase === 'onset' && (!fromHistory || Date.now() - at < T.quietMaxMs), endAt: data.phase === 'end' ? at : input.endAt });
    }
    else if (event.type === 'stage-sharing' && data.sharing === false && !fromHistory) pause(run, 'share_stopped');
  }
  // The latest speech and stage reports already in the store (the robot may be mid-utterance when a walk starts).
  function history() {
    const events = store.state.events || [];
    const found = new Set();
    for (let i = events.length - 1; i >= 0 && found.size < 3; i--) {
      const type = events[i].type;
      if ((type === 'stage-speech' || type === 'stage-shown' || type === 'stage-input') && !found.has(type)) { found.add(type); observe(events[i], true); }
    }
  }
  async function pump(signal, after) {
    while (!signal.aborted) {
      const result = await store.listen(after, 50000, signal, STAGE_EVENTS);
      after = result.cursor;
      for (const event of result.events) observe(event);
      if (result.events.length) poke();
    }
  }
  const joined = parts => parts.map(part => part.text).join('');
  function heard({ sessionId = null, role, delta } = {}) {
    const text = String(delta || ''), now = Date.now();
    if (!text) return;
    if (role === 'assistant') {
      robot.push({ at: now, text });
      while (robot.length && now - robot[0].at > T.echoWindowMs) robot.shift();
      const beat = run?.live; // e: the assistant transcript of this session since the cue
      if (beat && (!beat.sessionId || !sessionId || beat.sessionId === sessionId)) beat.spoken += text;
      const held = run?.interrupted; // the robot often finishes the part itself after answering (same session only)
      if (held && (!held.sessionId || !sessionId || held.sessionId === sessionId)) held.spoken += text;
    } else if (role === 'user') {
      if (now - user.lastAt > T.utteranceGapMs) user.parts = [];
      user.parts.push({ at: now, text });
      user.lastAt = now;
      user.spokeAt = now;
      clearTimeout(user.timer);
      const soFar = cleanUtterance(joined(user.parts));
      user.timer = setTimeout(utteranceEnded, run?.status === 'paused' && RESUME.test(soFar) ? T.resumeConfirmMs : T.utteranceGapMs);
      interrupted(now);
    }
    poke();
  }
  // f: >= interruptWords user words within interruptWindowMs during a beat pause it, unless the utterance is echo.
  function interrupted(now) {
    const token = run;
    if (!token?.live || token.status !== 'running') return;
    // A transcript with no meeting audio behind it is not a person (live 2026-09-15: "this slide presents" arrived
    // from a silent room and held the walk). Only gated once the page reports meeting audio at all.
    if (input.seen && !input.speaking && now - input.endAt > T.inputLagMs) return;
    // Only words after the last spoken "continue" count: the resume phrase's own words are not a new question.
    const recent = user.parts.filter(part => now - part.at <= T.interruptWindowMs && part.at > user.resumedAt);
    if (tokens(joined(recent)).length < T.interruptWords) return;
    const so = cleanUtterance(joined(user.parts));
    if (RESUME.test(so) || LEAD_IN.test(so)) return; // "okay, continue ... please" is no question; "all right," may start one
    if (echoShare(joined(user.parts), joined(robot.filter(item => now - item.at <= T.echoWindowMs))) >= T.echoRatio) return;
    pause(token, 'person_speaking');
  }
  // Resume on a short standalone "continue / go on / next ..." once the utterance has ended.
  function utteranceEnded() {
    const token = run, text = cleanUtterance(joined(user.parts));
    if (token?.status === 'paused' && text && tokens(text).length <= T.resumeMaxWords && RESUME.test(text) && resume(token, 'voice')) user.resumedAt = Date.now();
  }
  function attach() {
    if (attached) return;
    const abort = new AbortController();
    history();
    const after = store.state.cursor; // read synchronously after history(): no event falls between the two
    user.lastAt = Date.now(); user.parts = []; // quiet means quietMs of listening without user speech: it starts now
    attached = { abort, unsubscribe: live.onTranscript?.(heard) || (() => {}) };
    void pump(abort.signal, after).catch(() => {});
  }
  function detach() {
    if (!attached) return;
    attached.abort.abort(); attached.unsubscribe(); clearTimeout(user.timer); attached = null;
  }

  function publish(token, type, data = {}, patch = {}) {
    const beat = token.beats[token.index];
    store.update({ ...patch, presenter: { id: token.id, status: token.status, beat: Math.min(token.index, token.beats.length), total: token.beats.length, reason: token.reason, style: token.style, slide: beat?.slide ?? null, view: beat?.view ?? null } }, type, data);
  }
  // Everything the robot has said of the beat in progress, including before an earlier pause of the same part.
  const said = beat => [beat.before, beat.spoken].filter(Boolean).join(' ');
  // A deliberate move, stop or pause while the robot is presenting a part: stop it talking over the new screen.
  const hushIfPresenting = token => { if (token?.live) { try { live.hush?.(); } catch { /* best effort */ } } };
  // Remember the session in use, so a later change of id reads as a restart and not as a new one after a resume.
  function seeSession(token) { const id = live.activeSession?.()?.id; if (id) token.seen = id; }
  function pause(token, reason, data = {}) {
    if (!token || token !== run || token.status !== 'running') return false;
    // Keep what the robot had said of this part (all of it, across earlier pauses): after answering, it often finishes
    // the part on its own.
    if (token.live) token.interrupted = { index: token.live.index, spoken: said(token.live), sessionId: token.live.sessionId };
    // An utterance in progress belongs to before this pause: its "continue" must not undo a command's pause.
    if (reason !== 'person_speaking') { user.parts = []; clearTimeout(user.timer); }
    Object.assign(token, { status: 'paused', reason, live: null, lastEndAt: null });
    token.attempt?.abort(); // the beat in progress is dropped; it repeats on resume
    publish(token, 'presenter.paused', { reason, beat: token.index, ...data });
    poke();
    return true;
  }
  function resume(token, by) {
    if (!token || token !== run || token.status !== 'paused') return false;
    Object.assign(token, { status: 'running', reason: null });
    seeSession(token);
    publish(token, 'presenter.resumed', { by, beat: token.index });
    poke();
    return true;
  }
  // g: a new voice session id while running pauses the walk; the model there has not heard the earlier parts.
  // A beat whose session closes (or whose robot is put in another mode) pauses: the silence that follows is not the
  // natural end of the part, so the part is not marked covered.
  function watchSession(token) {
    const id = live.activeSession?.()?.id;
    if (!id) { if (token.live) pause(token, 'voice_session_lost'); return; }
    if (token.seen && id !== token.seen) { token.seen = id; pause(token, 'voice_restarted'); return; }
    token.seen = id;
    if (token.live && store.state.mode !== 'speak') pause(token, 'not_in_speak_mode');
  }

  const alive = (token, attempt) => token === run && token.status === 'running' && !attempt.signal.aborted;
  // First truthy check() value; null on timeout; false when the attempt is over (pause, stop, move).
  async function until(token, attempt, check, ms) {
    const deadline = Date.now() + ms;
    for (;;) {
      if (alive(token, attempt)) watchSession(token);
      if (!alive(token, attempt)) return false;
      const value = check();
      if (value) return value;
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await nap(Math.min(left, T.tickMs));
    }
  }
  // Nobody has spoken, or their last words were a "continue" that resumed the walk: quietMs. Otherwise they may be
  // mid-utterance between two transcript chunks: utteranceQuietMs.
  const quietFor = () => (!user.spokeAt || user.resumedAt >= user.lastAt ? T.quietMs : T.utteranceQuietMs);
  const robotQuiet = () => !speech.speaking && (!speech.end || Date.now() - (Number.isFinite(speech.end.at) ? speech.end.at : speech.end.arrived) >= T.robotQuietMs); // P5
  const quiet = () => Date.now() - user.lastAt >= quietFor() && robotQuiet();
  const title = () => String(store.state.title || '').trim() || 'the deck';
  // false when the text did not go out (no session, or its control socket is re-attaching); screen context is best effort
  async function tell(text) { try { return await live.context?.(text, false, { replay: false }); } catch { return false; } }

  // 0: a voice session in 'speak' mode. The model in a session that has not been briefed yet gets the plan first.
  async function ready(token) {
    const session = live.activeSession?.();
    if (!session?.id) { pause(token, 'no_voice_session', { voice: store.state.voice?.status ?? null }); return false; }
    if (token.seen && session.id !== token.seen) { token.seen = session.id; pause(token, 'voice_restarted'); return false; }
    token.seen = session.id;
    if (token.briefed !== session.id) {
      const n = token.beats.length, rules = 'RoboMeet moves your shared screen to each part and asks you to present it. If someone asks something, answer briefly; do not move ahead on your own. RoboMeet continues when someone says continue or next.';
      const delivered = await tell(token.briefed === null
        ? `You are about to present ${title()} in ${n} parts. ${rules}`
        : `Your voice session restarted during the presentation of ${title()} (${n} parts). Parts covered so far: ${partList(token.covered)}. Continuing with part ${token.index + 1}. ${rules}`);
      if (delivered !== false) token.briefed = session.id; // not delivered: the next beat's ready() sends it again
      if (token !== run || token.status !== 'running') return false;
    }
    if (store.state.mode !== 'speak') { pause(token, 'not_in_speak_mode'); return false; }
    if (store.state.meeting?.sharing !== true) {
      if (pause(token, 'not_sharing')) void tell('Your shared screen is off, so the presentation is paused. It continues when the screen is shared again and someone says continue.', { replay: false });
      return false;
    }
    return true;
  }
  // c: live.narrate; one retry after retryMs when it is not sent or not acknowledged (retry=false: a single try).
  async function cue(token, attempt, item, screen, retry = true, beforeCue, note = '') {
    for (let tries = 0; ; tries++) {
      const result = await Promise.resolve().then(() => live.narrate(item.say, { style: token.style, screen, beforeCue, note })).catch(() => null);
      if (!alive(token, attempt)) return false;
      // cued false: acknowledged, but the "begin" never went out (the control socket dropped)
      if (result?.sent && result?.acked && result.cued !== false) { if (result.sessionId) token.live.sessionId = result.sessionId; return true; }
      if (!retry || tries >= 1) { pause(token, 'voice_did_not_accept'); return false; }
      store.event('presenter.retry', { beat: token.index, reason: 'not_accepted' });
      if (await until(token, attempt, () => false, T.retryMs) === false) return false;
    }
  }
  async function beat(token) {
    const attempt = token.attempt = new AbortController();
    const index = token.index, item = token.beats[index], total = token.beats.length;
    if (!await ready(token)) return;
    // a: quiet. When the bound runs out because people keep talking, hold; a robot "mid-utterance" that never ended
    // (a lost end event) does not stall the walk.
    const calm = await until(token, attempt, quiet, T.quietMaxMs);
    if (calm === false) return;
    if (calm === null && Date.now() - user.lastAt < quietFor()) return void pause(token, 'person_speaking');
    if (!alive(token, attempt) || !await ready(token) || !alive(token, attempt)) return;
    // After an interruption: the robot usually answers and then finishes the part itself. If what it said covers the
    // part, it is done (no repetition); otherwise it continues from where it stopped.
    let note = ''; // RoboMeet's guidance for this cue; the part's text itself is never changed
    const interrupted = token.interrupted?.index === index ? token.interrupted : null;
    token.interrupted = null;
    if (interrupted) {
      const covered = coverageOf(item.say, interrupted.spoken);
      if (covered >= T.coveredAfterInterrupt) {
        token.covered.add(index);
        Object.assign(token, { live: null, lastEndAt: Date.now(), index: index + 1 });
        publish(token, 'presenter.beat_done', { beat: index, endedBy: 'covered_after_interruption', coverage: Math.round(covered * 100) / 100, speechMs: null, gapMs: null });
        return;
      }
      const spoken = interrupted.spoken.trim(), last = spoken.slice(-200).replace(/"/g, "'");
      const sameSession = !interrupted.sessionId || interrupted.sessionId === live.activeSession?.()?.id;
      const verbatim = token.style === 'verbatim';
      if (spoken && sameSession) note = verbatim
        ? `You were interrupted after saying: "...${last}". Say the rest of the text between the triple quotes from there.`
        : 'You were interrupted while presenting this part. Continue from where you stopped, without repeating what you already covered.';
      else if (spoken) note = verbatim
        ? `Your voice session restarted while you were saying this part. Your last words were: "...${last}". Say the rest of the text between the triple quotes from there.`
        : `Your voice session restarted while you were presenting this part. Your last words on it were: "...${last}". Continue from there without repeating what you already said.`;
    }
    const screen = `page ${item.slide + 1}, part ${index + 1} of ${total}`;
    const lines = viewLines(store.state.slides?.[item.slide]?.views?.[item.view]).join(' ');
    // b: the picture moves when the voice has accepted the cue, just before it is told to begin: the scroll then
    // lands about a second before the first word, and the robot never talks about something that is not on screen.
    let moved = false;
    // Returns false when the beat is over (paused, stopped, moved): live.narrate then does not send "begin".
    const move = async () => {
      if (!alive(token, attempt)) return false;
      if (moved) return true;
      moved = true;
      store.update({ slideIndex: item.slide, viewIndex: item.view }, 'presentation.stage', { slide: item.slide, view: item.view, by: 'presenter' });
      await sync();
      const onStage = () => shown.slide === item.slide && shown.view === item.view;
      if (shown.seen && !onStage()) await until(token, attempt, onStage, T.shownWaitMs);
      return alive(token, attempt);
    };
    // c: cue
    // Live: right after someone speaks (a "continue"), GPT Live may start the part before it acknowledges the cue.
    // Then the screen moves first, before the instruction, so it is never late.
    if (user.spokeAt && Date.now() - user.spokeAt < T.recentSpeechMs) { await move(); if (!alive(token, attempt)) return; }
    const cueAt = Date.now(), cueSeq = speech.seq;
    token.live = { index, cueAt, sessionId: live.activeSession?.()?.id ?? null, spoken: '', before: interrupted?.spoken || '' };
    publish(token, 'presenter.beat', { beat: index, total, slide: item.slide, view: item.view, cueAt });
    if (!await cue(token, attempt, item, screen, true, move, note)) return;
    await move(); // a voice without the beforeCue hook: move right after the cue, still before the first word
    // What is on screen, as quiet context for questions later. Sent after the cue: before it, it delayed the cue's
    // acknowledgment (live, 2026-09-15).
    // P4: the full visible text, line by line (a 350-character clip misplaced an equation in test 6).
    if (lines) void tell(viewText({ ...store.state, slideIndex: item.slide, viewIndex: item.view }));
    // d: the robot's own speech onset, strictly after the cue was sent
    const onsetAfterCue = () => speech.onset && speech.onset.seq > cueSeq && speech.onset.at >= cueAt ? speech.onset : null;
    let onset = await until(token, attempt, onsetAfterCue, T.onsetTimeoutMs);
    if (onset === false) return;
    if (!onset) {
      if (!quiet()) return void pause(token, 'voice_silent'); // re-cue only while nobody is speaking
      store.event('presenter.retry', { beat: index, reason: 'no_onset' });
      if (!await cue(token, attempt, item, screen, false, move, note)) return;
      onset = await until(token, attempt, onsetAfterCue, T.onsetTimeoutMs);
      if (onset === false) return;
      if (!onset) return void pause(token, 'voice_silent');
    }
    // e: done when the robot has finished this beat; the time budget is the hard cap.
    const finished = await until(token, attempt, () => {
      const end = speech.end && speech.end.seq > onset.seq && !speech.speaking ? speech.end : null;
      if (!end) return null;
      const tail = Date.now() - end.arrived;
      if (token.style === 'verbatim') {
        if (coverageOf(item.say, `${token.live.before} ${token.live.spoken.slice(0, end.spoken)}`) >= T.coverage) return { end, endedBy: 'speech_end' };
        return tail >= T.verbatimTailMs ? { end, endedBy: 'speech_end_partial' } : null;
      }
      return tail >= T.ownWordsTailMs ? { end, endedBy: 'speech_end' } : null;
    }, Math.max(0, onset.arrived + T.budget(item.say) - Date.now()));
    if (finished === false) return;
    const endAt = finished ? finished.end.at : Date.now();
    const data = { beat: index, endedBy: finished ? finished.endedBy : 'time_budget', speechMs: Math.max(0, Math.round(endAt - onset.at)),
      coverage: Math.round(coverageOf(item.say, said(token.live)) * 100) / 100, gapMs: token.lastEndAt == null ? null : Math.round(onset.at - token.lastEndAt) };
    token.covered.add(index);
    Object.assign(token, { live: null, lastEndAt: endAt, index: index + 1 });
    publish(token, 'presenter.beat_done', data);
  }
  async function loop(token) {
    try {
      while (token === run) {
        if (token.status === 'paused') { await nap(1000); continue; } // resume and stop poke this awake
        if (token.status !== 'running') break;
        if (token.index >= token.beats.length) { Object.assign(token, { status: 'done', reason: null }); publish(token, 'presenter.done', { total: token.beats.length }); break; }
        await beat(token);
      }
    } catch (error) {
      if (token === run && ['running', 'paused'].includes(token.status)) {
        Object.assign(token, { status: 'stopped', reason: `error: ${String(error?.message || error).slice(0, 200)}`, live: null });
        token.attempt?.abort();
        publish(token, 'presenter.error', { message: token.reason });
      }
    } finally {
      token.looping = false;
      if (!run || !['running', 'paused'].includes(run.status)) detach();
    }
  }
  function launch(token) { token.looping = true; attach(); void loop(token); }

  function start({ from = 0, style = 'own-words' } = {}) {
    const beats = beatsFrom(store.state);
    if (!beats.length) throw fail('No view in the deck has narration. Add "say" to the views you want spoken.', 400);
    stop('restarted');
    const token = { id: ++counter, beats, index: Math.min(Math.max(0, Math.trunc(Number(from)) || 0), beats.length - 1), status: 'running', reason: null,
      style: style === 'verbatim' ? 'verbatim' : 'own-words', seen: null, briefed: null, covered: new Set(), lastEndAt: null, live: null, attempt: null, looping: false };
    run = token;
    publish(token, 'presenter.started', { total: beats.length, from: token.index, style: token.style });
    launch(token);
    return status();
  }
  function stop(reason = 'stopped') {
    const token = run;
    if (!token) return status();
    if (['running', 'paused'].includes(token.status) && reason !== 'restarted') hushIfPresenting(token); // P5: a restart is not a move; never cut the robot for it
    token.attempt?.abort();
    if (['running', 'paused'].includes(token.status)) {
      Object.assign(token, { status: 'stopped', reason, live: null });
      publish(token, 'presenter.stopped', { reason, beat: token.index });
    }
    detach();
    poke();
    return status();
  }
  // Control actions run one at a time, in order. A move puts the stage there at once (TC-S5); the loop then waits for
  // quiet and cues that beat. Moving a paused or finished walk continues it from the new beat.
  function control(action, arg) {
    const result = queue.then(() => act(action, arg));
    queue = result.catch(() => {});
    return result;
  }
  async function act(action, arg) {
    if (!['pause', 'resume', 'next', 'previous', 'stop', 'goto'].includes(action)) throw fail(`Unknown presenter action ${action}`, 400);
    const token = run;
    if (!token) throw fail('No narrated presentation is running.', 409);
    if (action === 'stop') return stop('stopped');
    if (token.status === 'stopped') throw fail('The narrated presentation has stopped; start it again.', 409);
    if (action === 'pause') { if (token.status === 'running') hushIfPresenting(token); pause(token, typeof arg === 'string' && /^[a-z_]{1,40}$/.test(arg) ? arg : 'paused_by_command'); return status(); }
    if (action === 'resume') { resume(token, 'command'); return status(); }
    const total = token.beats.length;
    const target = action === 'goto' ? Number(arg) : token.index + (action === 'next' ? 1 : -1);
    if (action === 'goto' && !(Number.isInteger(target) && target >= 0 && target < total)) throw fail(`Beat index must be an integer from 0 to ${total - 1}.`, 400);
    if (target < 0 || target >= total) return status(); // no part in that direction
    const was = token.status, item = token.beats[target];
    hushIfPresenting(token);
    token.attempt?.abort();
    // An explicit move presents its part from the start: an old interruption of that part does not apply.
    Object.assign(token, { index: target, status: 'running', reason: null, live: null, lastEndAt: null, interrupted: null });
    seeSession(token);
    publish(token, 'presenter.moved', { action, beat: target, slide: item.slide, view: item.view }, { slideIndex: item.slide, viewIndex: item.view });
    if (was !== 'running') publish(token, 'presenter.resumed', { by: action, beat: target });
    if (!token.looping) launch(token);
    poke();
    await sync();
    return status();
  }
  function status() {
    const token = run;
    return token ? { id: token.id, status: token.status, beat: Math.min(token.index, token.beats.length), total: token.beats.length, reason: token.reason, style: token.style } : { status: 'idle' };
  }
  return { start, stop, control, status };
}
