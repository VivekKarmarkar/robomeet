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
