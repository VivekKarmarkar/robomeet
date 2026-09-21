# Problem statement v1: presenting in a meeting like a person (after test 6)

**Status (2026-09-16 17:15 CDT): P1-P7 fixed and tested; results in `docs/presentation-spec.md` (TC-P1..P7) and `tools/present-lab/runs/final_report.md`.**

Written 2026-09-16 16:30 CDT from the first live presenting test with Vivek (Meet evq-umst-jio, 35 minutes,
his nine dictated notes in `context_anchor.md`, the debrief in `errors_and_observations.md`, section "Test 6").
App root: `outputs/robomeet`. Everything below is measured or observed in that call unless marked "proposed".

## Where things stand

The presentation stage works: 1920x1080 shared screen drawn inside the Meet tab and sent as screen content;
PDFs, slide decks, documents, web pages and pictures become decks of screen-sized windows with pixel-exact
renders; `stage` scrolls between windows; `narrate` runs a walk that pauses when someone talks and resumes on
"continue". Live, a human viewer saw sharp text and figures, section-by-section navigation, custom framing, and a
robot that explains what is on screen and answers probing questions. Vivek's verdict: PDF test a partial success,
web-page test a success, "further testing required".

## Problems to fix, in Vivek's priority order

### P1 (highest). The robot freezes while the coding agent works on a delegated request
- Evidence: 9 delegated jobs in the call, 20-124 s each. During five of them the robot said 40-100 characters
  while Vivek spoke up to 980 ("are you still there or are you going to freeze when the rendering changes...
  Hello? I guess you are frozen again"). It also ignored a question he asked meanwhile, and when the result
  arrived it narrated the new screen instead of answering him.
- Cause: while a delegated function call (`ask_coding_agent`) is open, the GPT Live voice model mostly does not
  take new turns. The "keep the conversation going" commentary cue sent at job start (`src/live.mjs`,
  `execute`) is not enough.
- Proposed fix: close the function call immediately with an acknowledgment result ("the coding agent has the
  request; you will be told when it is done"), so the model's turn ends and it talks normally; when the coding
  agent replies, deliver the result as a spoken cue (`announce`, `session.commentary.append` or
  `instructions.append`) that tells the model to report it in its own words, without interrupting a person
  who is speaking (wait for meeting-audio silence, `stage-input`). Keep the job durable (`store.jobs`) and route
  the late result to the same session; if the session restarted, brief the new one. This is a design change:
  add it as a new path, do not remove the current one until the new one is measured.
- Acceptance: with a fake coding agent that takes 60 s, the robot answers three unrelated questions during the
  wait (offline test with the fake GPT Live harness in `test/live-narrate.mjs` and `test/server-state.mjs`);
  live with the observer (`tools/present-lab/live-observer.mjs`, extend it), the observer asks a question
  20 s into a 60 s job and hears an answer within 3 s; the late result is spoken when it arrives; no result is
  lost across a control-socket re-attach.

### P2. The robot misstates where it can get help
- Evidence: asked what it can do, it named only the coding agent and omitted the backend reasoning model
  (note 5 and note 7 item 2).
- Cause: `bin/attend.mjs` `buildBriefing` says it in one sentence inside a longer paragraph.
- Fix: a separate, plain fact in the briefing: "Two places to get help: your backend reasoning model
  (gpt-5.6-sol; thinking, notes, slides) and the coding session (files, code, research, presenting). Neither can
  search the web on its own; the coding session can." Keep the 6000-character budget (`briefing.trimmed`).
- Acceptance: offline, the built briefing contains the fact; live, the robot answers "where can you get help"
  with both.

### P3. A pointer while explaining
- Evidence: note 7 item 3: Vivek wants a visible laser pointer or highlight so the robot can point at an
  equation or element while explaining it.
- What exists: `src/meet-stage.js` draws an amber highlight box per view (`highlight` rect, 320 ms fade);
  `src/deck-builder.mjs` `highlightFor(view, phrase)` resolves a phrase on a view's text lines to a rect;
  `src/server.mjs` `cleanViews` accepts a rect or a phrase. Nothing lets the robot ask for one during a call.
- Fix: a `highlight` command and MCP tool (`{phrase}` or `{x,y,w,h}`, or `{equation: "(3)"}`), applied to the
  view on screen without moving it, cleared by `{off:true}` or the next move; a way for the voice model to
  request it (a delegated request the coding agent answers in under 2 s, or a direct tool if GPT Live allows
  one); and `narrate` beats may carry a `highlight` per beat so the box moves with the narration.
- Acceptance: offline, a highlight request on the live observer's robot changes the frame within 300 ms
  (`observer-present-hooks.js` `change`); the box surrounds the requested phrase (compare to the view's line
  boxes); live, "point at equation 3" produces a box around equation 3 while the robot talks about it.

### P4. The robot describes things that are not on screen the way it thinks
- Evidence: it said the initial vertical velocity is "on the second line of the blue box"; it is on the third.
  Vivek: "you're saying incorrect things... I can't even ask you my question".
- Cause: the per-view screen context the presenter sends (`src/presenter.mjs`, `tell`) is clipped to 350
  characters ("Visible text: ..."), so the box's third line never reached the model. Mid-call the fix was
  `send_context` with the exact lines, after which the explanation was right.
- Fix: send the full visible text of the view on screen, structured by line and block (headings, boxed lines,
  equation numbers), on every move, in chunks under the 500-token append limit (`context` chunks at 450
  characters). Picture decks (web captures) have no text layer: `src/deck-formats.mjs` should store the page
  text with positions per window (`lines`), as was done by hand for the OpenAI page.
- Acceptance: for the projectile PDF, the context for part 1 contains all three lines of the blue box with
  their labels; for a web capture, each window's `lines` match what the render shows (spot-check by eye).

### P5. The robot's speech gets cut off
- Evidence: note 2. Two causes found. (a) A narration restart re-cued the robot mid-sentence: the presenter's
  quiet gate (`quiet()` in `src/presenter.mjs`) treats the 350 ms speech-end detection as silence, and an
  `instructions.append` interrupts speech in progress. (b) GPT Live stops when the person starts talking; that
  is the model and stays.
- Fix for (a): require about 1 s of silence after the robot's own speech before any cue; `narrate` while a walk
  is running must not cue until the robot is silent; the same for `next`/`goto` (they hush deliberately, which
  is fine, but a restart is not a move).
- Acceptance: the offline narration oracle (`tools/present-lab/sync-fixture.mjs`) adds a case: a restart
  issued while the fake robot speaks does not cut it; live, no cut-off in a 3-part walk with a restart.

### P6. Picture reaches the viewer late after a long jump
- Evidence: after a jump from window 15 to window 5 of the web page (about 3700 px), Vivek saw nothing for a
  few seconds, then the picture. The robot side was transmitting throughout (frames, bytes, 960x540 at 20 fps,
  no quality limit).
- Fix: measure first with the live observer: time to a stable received frame after a long jump versus a short
  scroll; if the crossfade for long jumps starves the encoder of a full frame, force a full repaint/keyframe
  at the end of a move (a `dirty` paint of the settled frame is already there; check it reaches the encoder).
- Acceptance: observer sees a stable frame within 1.5 s of any move.

### P7. Tooling found wanting during the call
- The MCP `present` tool's schema (`src/mcp.mjs`) drops `views` (zod strips unknown keys); custom views only work
  through `bin/command.mjs present FILE`. Fix: accept `views` in the schema.
- MCP `reply`, `narrate`, `stage`, `present`, `presenter` return the whole state snapshot (60-75 KB) instead of a
  short acknowledgment; the coding agent's tool results overflow. Fix: return `{ok, presenter, sharing,
  slideIndex, viewIndex}`.
- `present_file` on openai.com fails with HTTP 403; a script using `headless: true`, a normal Chrome user agent
  and `--disable-blink-features=AutomationControlled` gets the page. Fix in `src/deck-formats.mjs`, keeping the
  sandbox and the private-network rules.
- A `narrate` beat over 900 characters is refused with a validation error only; the CLI and MCP should say the
  length.

## How to test (use the existing harness; do not invent a new one)
- `npm test` (126 tests) must stay green; add tests next to the code they cover.
- Offline oracles: `node tools/present-lab/sync-fixture.mjs` (narration sync, 7 checks) and
  `node tools/present-lab/fixture.mjs --quick` (picture quality).
- Live without a human: `VOICE=1 NARRATE=1 INTERRUPT=1 NEXT_MID=1 node tools/present-lab/live-observer.mjs`
  joins a second device of the robot account; extend it for P1 (question during a job), P3 (highlight change)
  and P6 (long jump). It bills GPT Live; keep runs short.
- Behavioral test loop: `/behavioral-test-loop` with `docs/presentation-spec.md`; add TC-P1..P7 there from the
  acceptance lines above. Record iterations (ffmpeg x11grab), keep the runs under `tools/present-lab/runs/`.
- The live test with Vivek is never auto-launched: when everything passes, say "everything is ready, let's do a
  test" on Telegram and wait for his link.

## Constraints (from CLAUDE.md and the project)
- Never modify working code in place; add new modular files and small marked hooks (`// stage:` style).
- Never start voice by hand; never print secrets (`data/control-token`, keys, env files).
- Give the robot facts, not scripts; it should be itself.
- Keep `README.md`, `tiers.md`, `docs/presentation-spec.md`, `errors_and_observations.md` and both
  `context_anchor.md` copies current; commit only when asked; notify on Telegram when done.
