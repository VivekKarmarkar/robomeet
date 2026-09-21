# RoboMeet presentation spec — "present like a human sharing a screen"

Source of intent: Vivek, 2026-09-14 (tests 4 and 5, Telegram). A human presenting in Meet shares a sharp
screen, scrolls or flips pages exactly as they talk about them, and the audience sees each change almost at
once. RoboMeet must do the same for PDFs, image slides and text slides. Every claim below is a numbered,
measurable test case. "Stage" = the picture RoboMeet shares into the meeting.

## Findings that motivated this spec (2026-09-15, code read)

- The picture Meet receives is drawn on a 1280x720 canvas inside the Meet page (`src/meet-media.js`
  `canvasOutput`, lines 32-68) from a video that already went through a local WebRTC encode/decode (the
  loopback bridge from the renderer tab). Two encodes, one downscale to 720p. The 1920x1080 renderer canvas
  change of 2026-09-14 never reached Meet.
- The shared track has no `contentHint`, so Chrome's encoder treats slides like camera video.
- `bin/attend.mjs` turns sharing on at join, showing the previous meeting's deck (test 5 opened with a stale
  projectile page on screen).
- Narration is not tied to what is visible: a whole-PDF talk track was spoken while half a page showed.
- Slide changes need a backend-model or coding-agent round trip; there is no scrolling.
- `share off` failed repeatedly mid-call in test 5 (root cause to be found).
- The voice session was killed when OpenAI's control WebSocket closed (`control_connection_lost`,
  2026-09-14T23:23:03Z) and restarted without its conversation memory.

## Test cases

### Resolution and fidelity
- **TC-R1** The track Meet gets from `getDisplayMedia` reports 1920x1080.
- **TC-R2** The stage is drawn inside the Meet page. No WebRTC re-encode sits between the stage pixels and
  Meet's own encoder.
- **TC-R3** The shared track carries `contentHint` `detail` or `text`, so Chrome encodes it as screen content.
- **TC-R4** Offline oracle: through a Meet-like WebRTC hop (bitrate-capped, same codec family), a text-heavy
  PDF view arrives at 1920x1080 and scores SSIM >= 0.95 against the ideal stage frame, and beats the old path.
- **TC-R5** Live Meet: a second participant receives the presentation as screen content at the highest
  resolution Meet sends to a large tile, measured from its inbound-rtp stats, with a readable capture.
- **TC-R6** Default PDF view is fit-to-width: 10 pt body text is drawn at >= 28 px on the stage.

### Sync (narration follows the screen)
- **TC-S1** In a narrated presentation, each beat's view is on stage before the robot starts speaking that
  beat, by no more than 1.5 s.
- **TC-S2** The robot never narrates content that is off stage: at every speech onset the stage shows the
  view of the beat being spoken.
- **TC-S3** Moving between views scrolls or zooms smoothly (animated, >= 20 painted fps during the move),
  like a human scrolling, not a jump cut.
- **TC-S4** If a person speaks during narration, the presentation holds on the current view until resumed
  (spoken "continue", "go on", "next" or a command).
- **TC-S5** Manual next/previous/go-to reach the in-page stage within 150 ms of the command.

### Latency
- **TC-L1** Stage change to the second participant receiving the changed frame: median <= 600 ms, live Meet.
- **TC-L2** A 1-page PDF goes from command to on-screen at the participant in <= 5 s.
- **TC-L3** Gap between consecutive narrated beats (robot audio end to next audio start): median <= 2.0 s.

### Reliability
- **TC-X1** A new meeting starts with an empty stage; no deck from an earlier meeting is shown at join.
- **TC-X2** Share off/on succeeds 10 of 10 times in a live meeting, and RoboMeet's `sharing` state matches Meet.
- **TC-X3** Presenting never stops or restarts the voice session.
- **TC-X4** The robot's briefing states exactly what it can and cannot do with the screen.
- **TC-X5** `npm test` stays green, and the old bridge path still works as a fallback.

### After live test 6 (2026-09-16; problems in `docs/problems/presenting-v1.md`)
- **TC-P1a** A delegated `ask_coding_agent` call is answered at once with an acknowledgment, so the voice model's
  turn closes; the real result is delivered later as its own cue. Offline: the function output is sent within 1 s
  of the call, not when the coding agent replies.
- **TC-P1b** During a 60 s job the robot keeps answering: offline, the fake model receives no blocking open call
  and gets a spoken cue with the result once the job completes; the cue waits for meeting-audio silence.
- **TC-P1c** A late result survives a control-socket re-attach and a session restart (delivered to the session
  that is active, with a note that it belongs to an earlier request).
- **TC-P1d** Live: the observer asks a question 20 s into a 60 s job and hears the robot answer within 3 s; the
  result is spoken when the job completes.
- **TC-P2** The launch briefing states, as its own sentence, both places the robot can get help (backend
  reasoning model and coding session) and that neither searches the web by itself except through the coding
  session.
- **TC-P3a** A `highlight` command (phrase, equation number, or rectangle) draws a box on the view on screen
  without moving it; `off` clears it. The received frame changes within 300 ms offline (stage) and the box
  surrounds the requested text (compared with the view's line boxes).
- **TC-P3b** The voice model can request a highlight itself (`point_at` tool), and narrate beats may carry a
  `highlight`.
- **TC-P4** Every move (narrated or `stage`) gives the robot the full visible text of the view, line by line; for
  the projectile PDF part 1 it contains all three lines of the blue box with their labels.
- **TC-P5** A cue never interrupts the robot: the presenter waits for about 1 s of the robot's silence, also when
  a narrated walk is restarted while the robot is mid-sentence (including a long, 20 s+ answer).
- **TC-P6** A long jump (many windows) reaches the participant as a stable frame within 1.5 s (live observer).
- **TC-P7a** MCP `present` accepts `views`; command tools return a short acknowledgment, not the whole state.
- **TC-P7b** `present_file` builds a deck from a web page that blocks automated browsers (openai.com), with the
  page text per window; an over-long narration beat is refused with its length stated.

## Results (2026-09-15; offline oracles, `npm test`, and live Meet runs in `tools/present-lab/runs/iter*`)

| TC | Result | Evidence |
|---|---|---|
| R1 | ✅ | the track Meet gets reports 1920x1080 at 30 fps (`test/meet-stage.mjs`) |
| R2 | ✅ | the stage is a canvas inside the Meet page; no local re-encode |
| R3 | ✅ | `contentHint` `detail`, guarded against downgrades; live stats show `contentType: screenshare` |
| R4 | ✅ | 1920x1080, SSIM-Y 0.999, PSNR 52 dB (old path: 480x270, SSIM-Y 0.85) |
| R5 | ✅ | live: AV1 screenshare, 1143x643 layer for a 1600x900 window; SSIM 0.976 (PDF), 0.9988 (.pptx) |
| R6 | ✅ | fit-to-width views of a 2400 px page: 10 pt text at about 31 px |
| S1 | ✅ | offline lead 0.81-0.83 s; live 0.9-1.0 s |
| S2 | ✅ | right view at every onset offline; live, "next" mid-part stops the robot in 0.77-0.88 s |
| S3 | ✅ | live 19-23 fps in the first second of a scroll |
| S4 | ✅ | live: a question pauses, "Okay, continue" resumes, a covered part is not repeated; phantom transcripts ignored |
| S5 | ⚠️ | stage shown 80 ms and 160 ms after a live `next` (budget 150 ms) |
| L1 | ✅ | live: first changed frame at the participant after 342-528 ms over 6 runs |
| L2 | ✅ | a one-page PDF builds in 1.2 s; share command to participant seeing it: 2.5-3.3 s |
| L3 | ⚠️ | offline median 1.8 s; live about 2.8-3 s (GPT Live acknowledgment and start 1.8-2.2 s, end detection about 1 s) |
| X1 | ✅ | sharing false at join in every live run |
| X2 | ✅ | 13 of 13 share off/on cycles clean over 5 live runs (the spec asks for 10 in one run; the most in one run was 5) |
| X3 | ✅ | no voice restarts in any live presentation run |
| X4 | ✅ | briefing states the screen facts, including that only the coding session can stop the share |
| X5 | ✅ | `npm test` green; the bridge path was not changed and was not re-tested live this session |

## Results for TC-P1..P7 (2026-09-16; `tools/present-lab/runs/iter9-live-jumps` to `iter12-live-voice`, `npm test` 148/148)

| TC | Result | Evidence |
|---|---|---|
| P1a | ✅ | the function output is sent at once with `status: accepted` (`test/late-results.mjs`) |
| P1b | ✅ | the result is cued after meeting audio and the robot are quiet; long results go to context first |
| P1c | ✅ | a result finishing after a session closed is told to the next session; leaving the meeting drops it; a control-socket gap is retried |
| P1d | ✅ | live, 3 runs: the robot answered an unrelated question 1.3-1.7 s after it ended, 20 s into a 45 s job, and spoke the result 1.2-1.9 s after the reply ("OpenAI makes it" ... "twenty-one test files") |
| P2 | ✅ | live: "Two places. My backend reasoning model or the coding session, which I can ask to read files, run code, or do research for us." |
| P3a | ✅ | `highlight` by phrase, equation row or rectangle; in-page box visible within 300 ms; live, the participant saw the box (iteration 9) |
| P3b | ✅ | live, 3 runs: "Can you point at equation three?" drew a box exactly on the equation (3) row 2.6-4.0 s after the question; narrate beats take `highlight` |
| P4 | ✅ | the full view text, line by line, on every move (part 1 carries all three blue-box lines in order); live, the robot described equation (3) as the initial conditions |
| P5 | ✅ | a restart during a 25 s answer waits for it to end plus ~1 s (unit test); oracle: first cue 1054 ms after the robot's audio ended; gap between parts still 1.86 s |
| P6 | ✅ | long jumps (window 1 to 15 and back) settle at the participant in 1.03-1.18 s; a deck swap no longer cuts (it reached the participant 3.8 s late in iteration 10; 0.46 s after the fix) |
| P7a | ✅ | MCP `present` keeps `views`; command tools answer with a summary under 1.5 KB |
| P7b | ✅ | the openai.com article builds as a 15-window deck with its text; over-long beats are refused with their length |
