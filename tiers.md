# RoboMeet — Capability Tiers

Three tiers of capability, each building on the last. A tier is not "done" until every item in it works reliably.

---

## Tier 1 — Attend

Can the robot join and stay in a call with clean audio, no echo, while Vivek is on his phone or laptop?

| Capability | Platform | Status |
|---|---|---|
| Join a Google Meet link | Google Meet | ✅ Working (tests 1–4) |
| Create/host a Google Meet and share the link | Google Meet | ✅ Working (GWS API `spaces create`) |
| Vivek joins from phone while robot is in the call | Google Meet | ✅ Verified (test 4, phone) |
| Vivek joins from laptop while robot is in the call | Google Meet | ✅ Verified (tests 1–3, laptop) |
| Echo handling (null sink, no feedback loop) | Google Meet | ✅ Working (`robomeet_null` PulseAudio sink) |
| Join a Zoom link | Zoom | ❌ Not implemented |
| Vivek joins Zoom from phone or laptop | Zoom | ❌ Not implemented |

### Notes
- Google Meet admission: same-account → "Join here too" flow (never "Switch here"); external links → knock and wait for admission.
- Zoom is unimplemented. Would need a Zoom Web SDK or Playwright-driven join flow, plus audio routing.

---

## Tier 2 — Converse

Can it hold a natural conversation, with low latency, saying correct things about itself and its setup?

| Capability | Status |
|---|---|
| Responds naturally to open conversation | ✅ Working (tests 1–4) |
| Knows its own identity (name, what it is, how it works) | ✅ Working — briefing covers this |
| Knows its voice model (gpt-live-1) and voice name (marin) | 🔧 Just added to briefing — untested |
| Knows its backend model (gpt-5.6-sol) and delegation flow | ✅ Working (test 4: answered correctly) |
| Knows the coding agent, session name, MCP connection | ✅ Working (test 4: answered correctly) |
| Delegates to coding agent when it doesn't know something | 🔧 Just added to briefing — untested |
| Does not guess or hallucinate (if unsure, delegates or says so) | ⚠️ Partially — hallucinated PDF contents in test 4 |
| Does not claim actions it cannot perform | ⚠️ Falsely claimed to stop screen share in test 4 |
| Latency: end-of-speech to first robot audio | ✅ 1.4–1.5 s (direct path); GPT Live turn-taking ~1 s is the floor |
| Latency: admitted to greeting heard | ✅ ~3.3 s |
| Does not freeze during delegation | ✅ Commentary cue fix in place; robot keeps talking |
| Express itself freely, not scripted | 🔧 Just strengthened in briefing — untested |

### Key metrics
- **End-to-end latency:** 1.4–1.5 s (direct single-hop path). ~0.7–1.1 s is GPT Live's own turn-taking, untunable. Meet adds ~0.3–0.5 s.
- **Delegation round-trip:** depends on the coding agent's response time (typically 5–30 s for real work; the 6-min delay in test 4 was context compaction, not normal).

---

## Tier 3 — Present

Can it show content on screen as well as a human would — readable, smooth, no latency while navigating?
Spec with numbered test cases: `docs/presentation-spec.md`. Design: `docs/stage-design.md`. Evidence: `docs/stage-research.md`.

| Capability | Status (2026-09-15) |
|---|---|
| Full-resolution shared screen (1920x1080 stage drawn inside the Meet page, marked as screen content) | ✅ Offline oracle: SSIM-Y 0.999, 1920x1080. Live Meet: participant receives it as `screenshare` (AV1, 1143x643 layer for a 1600x900 window), SSIM 0.976 for the PDF, 0.9988 for a slide |
| Old path (for comparison) | ❌ Arrived at 480x270 to 640x360, SSIM-Y 0.85-0.88: no content hint, so Chrome treated slides as webcam video |
| Present a PDF as a scrolling document (fit-to-width views, pixel-exact renders) | ✅ `present_pdf`, `bin/present-pdf.mjs`, `bin/deck.mjs build` |
| Scroll/navigate by itself (`stage` view by view, smooth eased scroll) | ✅ Live: the participant sees a move in 342-528 ms over 6 runs, 19-23 fps during the scroll |
| Narrated presentation synced to the screen | ✅ Offline oracle 7/7: screen moves ~0.8 s before each part is spoken, right view at every speech onset, median gap 1.8 s. Live (4 voice runs): screen moves ~0.9-1.0 s before the first word; a real question pauses it; "Okay, continue" resumes it; a part the robot already covered while answering is not repeated |
| No stale deck at join | ✅ Live: sharing false at join |
| Share off/on reliability | ✅ Live: 5 of 5 cycles, state matches what the participant receives |
| Present image slides and text slides | ✅ same stage |
| Present PPT/PPTX/ODP, DOCX, HTML pages, tall images | ✅ `present_file` / `bin/deck.mjs build`: slides whole, documents and web pages as reading windows. Live: a .pptx deck received at SSIM 0.9988, slide changes seen in 342-422 ms |
| "Next" or "go to" while the robot is mid-sentence | ✅ Live: the robot stops talking 0.77-0.88 s after the command (it used to finish the old part over the new screen); the screen moves in 0.4-0.5 s |
| Robust to a phantom transcript (speech recognition inventing words in a silent room) | ✅ Only transcripts with meeting audio behind them pause the walk (found live 2026-09-15: "this slide presents" from a silent room held the walk) |
| The robot knows it cannot stop the share itself | ✅ in the briefing facts |
| Keeps talking while the coding agent works (test 6: it froze) | ✅ Live, 3 runs: answered a question 1.3-1.7 s after it ended during a 45 s job; spoke the result 1.2-1.9 s after it arrived |
| Points at what it explains | ✅ Live: "point at equation three" boxed exactly that row 2.6-4.0 s later; the coding session can point too (`highlight`) |
| Knows exactly what is on screen (test 6: misplaced an equation) | ✅ The full visible text, line by line, on every move |
| Says where it can get help | ✅ Live: "my backend reasoning model or the coding session" |
| Web pages that block bots | ✅ openai.com builds as a 15-window deck with its text |

### Why the old presentation looked bad (measured)
1. The picture Meet received was redrawn on a 1280x720 canvas after a local WebRTC encode/decode (two encodes, one downscale).
2. The shared track had no `contentHint`, so Chrome encoded it as camera video and shrank it under bandwidth
   pressure (480x270 in the oracle).
3. Nothing tied the narration to what was visible.

### Remaining limits
- Gap between narrated parts in a live meeting is about 2.8-3 s (1.8 s offline). GPT Live's acknowledgment plus the
  start of speech takes 1.8-2.2 s and about 1 s of silence is needed to know a part ended; TC-L3's 2.0 s holds
  offline, not live.
- After "Okay, continue", GPT Live sometimes carries on by itself before RoboMeet's cue; RoboMeet then counts what it
  said and skips the part if it is covered. A cut-off tail word or two can precede the next part.
- Meet sends each viewer a layer sized to their presentation tile (1143x643 for a 1600x900 window in the live test),
  so a small window or phone gets fewer pixels. The fit-to-width views keep text as large as possible for any layer.
- A scroll arrives at a lower frame rate than a static page on a slow link. The encoder keeps resolution and drops frames.

## Summary

| Tier | Core question | Status |
|---|---|---|
| 1 — Attend | Can it join and stay in a call? | ✅ Google Meet works; Zoom not implemented |
| 2 — Converse | Can it talk correctly with low latency? | ✅ Mostly working; new briefing items untested |
| 3 — Present | Can it show content like a human? | ✅ Sharp, scrolling, synced; keeps talking while work runs; points at what it explains. First human test (test 6) partial success; its seven problems fixed and measured in iterations 9-12 |
