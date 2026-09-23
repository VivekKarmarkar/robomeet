# Simulated participant

Test the robot with a second GPT Live voice instead of a human. "Alex" is a physicist persona with a cartoon face,
steered one step at a time by private stage directions; every robot answer is graded against the truth read from the
robot's own state at that moment.

Why a second GPT Live and not text-to-speech: synthetic speech followed by digital silence does not reliably mark the
end of an utterance for a full-duplex model, so the old harness scored the same test 7/8 one run and 3/8 the next. A
second GPT Live is a real full-duplex speaker; two of them took eight clean turns in 36 s with 0.8 s of overlap.

## Run it headless (no Meet, no browser)

```
node tools/sim-participant/duplex-loop.mjs --out report.json --audio runs/<name>
```

Robot side is RoboMeet as shipped: `sessionConfig` from `src/live.mjs`, every tool call executed on the real server,
the real screen feed and truth watcher. `pacer.mjs` is each side's microphone (one tick of the other's speech, or
silence, every 100 ms). `--audio` also writes `robot.wav`, `alex.wav` and `timeline.json` on one clock.

## Render the demo video (headless, page pixels only)

```
node tools/sim-participant/record-room.mjs runs/<name> runs/<name>/room.mp4 --tighten 1.2
node tools/sim-participant/make-demo.mjs runs/<name> runs/<name>/room.mp4 runs/<name>/demo.mp4
```

`room.html` shows the robot's real shared screen, both animated faces, captions and the live checklist. Frames are
screenshots of that page only; nothing from the desktop can appear. Each face is moved by its own voice's loudness
and band balance at that instant. `--tighten` shortens silences over 1.2 s; nothing anyone said is re-timed.

## Run it in a real Google Meet

```
node tools/sim-participant/meet-run.mjs
```

Blocked until the robot is signed in again: its browser session and the Meet API token have both expired
(`node bin/login.mjs`). Alex joins as a second device of the robot's account (Meet rejects signed-out guests on this
laptop), via a fresh copy of `data/browser-profile`. This run records the meeting audio only; video from inside Meet
needs a page-level capture, not a desktop recording.

## Faces

`src/face.js` draws the face; `src/meet-face-hook.js` puts it on the camera Meet sends and moves the mouth with the
voice Meet sends. Off unless `ROBOMEET_FACE=1`; `ROBOMEET_FACE_CHARACTER=robot|human`, `ROBOMEET_FACE_NAME`.

## The honest protocol (2026-09-22)

The first simulated tester planted false claims ("I'm looking right at it, it's the cosine one") and leaned on false
pressure. The honest protocol replaces it:

- **Alex never states anything false.** Her input is muted, so she cannot hear the meeting, echo the robot, answer her
  own questions or fill silences; every word she says is a scripted, true line (`protocol/protocol.json`). When she
  remarks on the box, the remark is written by the harness from a vision model looking at the real stage render
  (`box-eyes.mjs`), and only when it sees what it says.
- **124 scenarios in 11 meetings** (`protocol/protocol.json`, designed by a 6-lens workflow plus a coverage critic,
  meeting 11 added by hand); special mechanics (barge-ins, backchannels, long silences, a coding session that fails or
  answers out of order, voice restart, rejoin with recap, a session without point_at, narrated walks) are in
  `protocol/mechanics.mjs`.
- **Graded like a person would:** did it (tools, screen part, box contents and tightness by eye), content (against the
  PDF and physics), nothing false (against the robot's real briefing, `briefing.mjs`, and what actually happened), and
  feel (time to first word, length, talking over Alex, speaking when told to listen).
- **Faithful to production:** the real server, session config (briefing as prompt and context, as attend sends it),
  10 fps screen feed, truth watcher, presenter and late-result delivery; `room-signals.mjs` supplies the page's speech
  and stage events.

Run every meeting in parallel (about 35 minutes, needs GPT Live credits):

    tools/sim-participant/run-all.sh tools/sim-participant/runs/<name>      # or: node honest-loop.mjs protocol/protocol.json --pdf-text protocol/pdf-text.txt --out <dir> --chapters 3
    node tools/sim-participant/review-honest.mjs tools/sim-participant/runs/<name> --essential   # review.md: every failure, strict and essential

`recite-probe.mjs` measures what makes the robot talk unasked after a screen move (`runs/evidence/recite-probe.md`).
The demo: `build-honest-demo.mjs <plan.json> <dir>` then `render-honest-demo.mjs <dir> <out.mp4>` (headless, page pixels
only; the shared screen is the real `src/meet-stage.js` render).

Runs: `runs/honest-4` is the clean baseline (5/116 strict, 12/116 essential). `runs/honest-5` was cut short when the
account ran out of GPT Live credits and is not used. `runs/honest-2`, `honest-3` predate fixes to the harness itself.
