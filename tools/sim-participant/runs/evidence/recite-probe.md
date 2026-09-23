# What makes the robot talk unasked after a screen move (2026-09-22)

tools/sim-participant/recite-probe.mjs: one real robot session per condition (real briefing and session config, real
server), nobody speaking, the screen moved 4 times, 12 s apart. Counted: moves followed by robot speech within 8 s.

| screen context sent to the voice model                         | unprompted speech |
|-----------------------------------------------------------------|-------------------|
| production: 10 fps SCREEN feed + full visible text on each move | 4 / 4             |
| full visible text only                                          | 4 / 4 (whole derivations) |
| compact text (headings + formulas) + feed                       | 4 / 4             |
| full text queued to the backend model + feed                    | 3 / 4             |
| SCREEN feed only                                                | 1 / 4 ("Okay, I see it.") |
| nothing                                                         | 0 / 4             |

Conclusion used for the fix: any informative screen update landing in a quiet room is a cue to present. The full text
is now held until someone in the meeting starts speaking (src/screen-context.mjs, untilSpeech), so it arrives with
their question. With questions asked after each move, equation (8) was answered correctly (sin²θ over 2g) once the
formula transcription (bin/deck-math.mjs) was in place. Small samples: 4 moves per condition.

# How long a move or a box takes, and whether it is the right one (2026-09-22, tools/sim-participant/tool-probe.mjs)

Five plain requests from Alex ("Next part, please.", "Box equation seven.", "Go to the top.", "Box equation three.",
"Go to the end."), one real robot session each, run while the full protocol was also running. Time is from the end of
Alex's request to the backend's function call.

- Default backend reasoning effort: calls at +2.8 s to +7.7 s, one at +15.9 s and one at +23.8 s; "Box equation three"
  boxed (7) again, and "Go to the end" also re-boxed (7) and scrolled "next" first.
- reasoning.effort "low": no faster (+4.0 s to +17.6 s), and three requests got the wrong or a late action.

Every move and box goes through the backend reasoning model, so it takes seconds and, when calls queue, can act on a
stale request. Not fixed by a setting; this is the fast path (Jev or client delegation) that ideal_version.md lists.

# The first fix made tool use worse; the protocol caught it (2026-09-23)

The first fix held a part's full text until someone started speaking (src/screen-context.mjs, untilSpeech). The full
re-run (runs/honest-6) removed the unasked narration (14 answers -> 0) but the robot stopped using its tools: the
expected scroll/point_at/ask_coding_agent never ran in 17 scenarios, against 8 in the baseline, while it said "I'm at the
top". tools/sim-participant/tool-probe.mjs, speech signals on, 2 sessions per condition, 5 action requests each plus
"What does equation eight say, exactly?":

| how the part's content reaches the robot         | tool calls on time | equation (8) answered right |
|--------------------------------------------------|--------------------|-----------------------------|
| held until someone speaks (first fix)            | 4 / 10             | 1 / 2                       |
| full text on every move (original production)    | 10 / 10            | 2 / 2 (but narrates parts)  |
| short SCREEN feed only                           | 10 / 10            | 1 / 2 (called (8) the range)|
| deck map once per deck (final fix)               | 10 / 10            | 2 / 2                       |

A single earlier session with the deck map made no tool calls at all (0/6), so session-to-session variance is large;
the full protocol re-run (runs/honest-7) is the measurement that counts.

# Load, not the fixes, made answers slip a turn (2026-09-23)

Full protocol runs with 11-12 meetings in parallel (about 24 voice sessions plus judge and vision calls) got slower
through the night: "no spoken reply" to a question in 13 scenarios (runs/honest-4, 22:13), 21 (honest-6), 24 (honest-7,
00:37), and 45 (baseline code) and 49 (final code) in the side-by-side run (runs/ab-base, runs/ab-final, 01:05). In most
of these the robot's answer to the question arrived during the next scenario. At 01:52 a single session (tool-probe.mjs,
final code, deck map, speech signals on) answered every request at once and made every tool call in 2.5-4.5 s:
scroll next +4.5 s, point_at (7) +2.5 s, scroll top +3.3 s, point_at (3) +2.6 s, scroll end +2.8 s, and read equation
(8) correctly. run-all.sh now runs at most 4 meetings at a time (MAX_PARALLEL).
