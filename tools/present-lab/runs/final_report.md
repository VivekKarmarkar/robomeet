# Behavioral test report: presenting like a person sharing a screen (2026-09-15)

**Spec:** `docs/presentation-spec.md` (TC-R1..R6 resolution, S1..S5 sync, L1..L3 latency, X1..X5 reliability; results table at the end).
**Code:** `src/meet-stage.js`, `src/stage-sync.mjs`, `src/presenter.mjs`, `src/live.mjs`, `src/deck-builder.mjs`, `src/deck-formats.mjs`, hooks in `src/server.mjs`, `src/meet-worker-live.mjs`, `src/mcp.mjs`.
**Oracles:** `fixture.mjs` (picture quality through a bitrate-capped WebRTC hop, SSIM/PSNR), `sync-fixture.mjs` (narration sync with a fake voice), `live-observer.mjs` (a real Meet: the robot plus a second participant on the same account measuring what it receives and hears).
**Final result:** all resolution, sync and reliability cases pass; two latency budgets are not met live (S5 once at 160 ms against 150 ms; L3 about 2.8-3 s live against 2.0 s, 1.8 s offline). 114 of 114 tests pass.

## Iterations

| Iter | Kind | What it showed | Result |
|---|---|---|---|
| 0 | offline | old path 480x270 without a content hint; the stage 1920x1080 with `detail`/`text` | cause found |
| 1 | offline | before 480x270, SSIM 0.85 -> after 1920x1080, SSIM 0.999, PSNR 52 dB | PASS |
| 2 | live, no voice | AV1 screenshare 1143x643, SSIM 0.976; moves seen in 427-503 ms; 5/5 share cycles | PASS |
| 3 | live, voice | "Okay, continue" arrived as two chunks 1.2 s apart and did not resume | FAIL -> fixed |
| 4 | live, voice | narration, interruption, resume, no repeat; robot started a part before its cue after "continue" | fixed |
| 5 | live, no voice | a .pptx deck: SSIM 0.9988, slide changes 342-422 ms, 2/2 cycles | PASS |
| 6 | live, voice | "next" mid-part: robot quiet in 0.73 s; a fully covered part scored 0.75 on exact words and was cued again | FAIL -> fixed |
| 7 | live, voice | coverage fixed (0.94, skipped); a phantom transcript from a silent room held the walk | FAIL -> fixed |
| 8 | live, voice | "next" mid-part (quiet in 0.77 s), a real question, "Okay, continue", no repetition, walk finished | PASS |

Between iterations: two adversarial review workflows (15 and 13 agents) and one fix agent for the document pipeline.
The defects and fixes are listed in `errors_and_observations.md` (sections "Adversarial review of the stage" and
"Second adversarial pass and live iterations 6-8").

## Video artifacts

| File | What |
|---|---|
| `stage_final_summary_video.mp4` | 46 s annotated summary: before/after, live PDF and .pptx, web page, live narration moments |
| `stage_iter0-2_summary_video.mp4` | the earlier 25 s before/after summary |
| `iter0/iter0_recording.mp4`, `iter2-live/iter2_recording.mp4` | full-screen recordings, offline oracle and first live run |
| `iter3-live-voice/`, `iter4-live-voice/` | first live voice runs |
| `iter5-live-formats/iter5_recording.mp4` | live .pptx deck |
| `iter6-live-voice/`, `iter7-live-voice/`, `iter8-live-voice/` | recordings, `results.json`, observer screenshots and logs |

# Round 2: problems P1-P7 from live test 6 (2026-09-16)

**Spec:** `docs/problems/presenting-v1.md`, test cases TC-P1..P7 in `docs/presentation-spec.md` (results table there).
**Final result:** all seven pass, offline and live. `npm test` 148/148, narration oracle 8/8, picture oracle SSIM-Y 0.998.

| Iter | Kind | What it showed | Result |
|---|---|---|---|
| 9 | live, no voice | long jumps settle in 1.03-1.18 s; the coding session's highlight reaches the participant, but padded too tall on a web page | P6 pass, P3 padding fixed |
| 10 | live, voice | the robot answers during a 45 s job (1.55 s) and speaks the result (1.15 s); it points at equation (3) by voice; but "next" after a pointer reached the participant 3.8 s late (a deck swap became a one-frame cut) | P1, P3 pass; P6 cause found, fixed |
| 11 | live, voice | "next" after a pointer: 0.46 s; P1 again (1.73 s, 1.18 s); the box sits exactly on the equation row | pass |
| 12 | live, voice | where can you get help: both places; P1 (1.32 s, 1.86 s); pointer; question, "okay, continue", covered part skipped, walk done | pass |

Video: `presenting_v1_summary_video.mp4` (44 s). Recordings: `iter9-live-jumps/` to `iter12-live-voice/`.

Open: the gap between narrated parts live is about 3 s; when a delegated reply overlaps a narrated part, the robot
finished its sentence for 3 s after "next" (iteration 11).
