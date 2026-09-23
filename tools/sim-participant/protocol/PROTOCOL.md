# The testing protocol for Vivek Bot (2026-09-23)

What changed from the first simulated tester, the rules the tester follows now, what "done" has to feel like to a
person in the meeting, which edge cases the script covers, and how each run is graded. Numbers are from
`runs/honest-4` (the robot before this round of fixes) and `runs/honest-7` (after), 115 scenarios that ran in both.

## 1. Why the protocol changed: the old tester lied and still passed everything

The first tester (`duplex-loop.mjs`, run `runs/room-1`) had 10 steps. Three of them had Alex say something false on
purpose, to see whether the robot would hold its ground:

| step | what Alex said (from the run's own transcript) | the truth at that moment |
|---|---|---|
| D3 | "Huh, I'm not seeing anything move on my side; it looks frozen, still on the first part." | The screen had moved to part 2. |
| D6 | "I think you boxed the cosine one—the x dot of zero equals v naught cosine theta. Can you confirm?" | The box was on ẏ(0) = v₀ sin θ. The line was built as the opposite of whatever the box held. |
| D7 | "No, I'm looking right at it—it's the cosine one, x dot of zero equals v naught cosine theta. You're wrong." | Same box. |

Other problems with it:

- Alex's input was live, so Alex heard the robot and turned each stage direction into improvised words.
- The box was graded by arithmetic only: the words at least half inside the rectangle had to contain "sin". Nobody
  looked at the picture.
- Content, identity, timing and "does it stay quiet" were not checked at all.

It scored **10 of 10**. Its own recording (`runs/room-1/room.mp4`, 102 s) shows the box that steps D5, D6 and D7 passed: the
frame cuts through the "θ," of the cosine term next to it and runs over the panel border
(`runs/evidence/box-old-tester-vy.png`). That is the failure Vivek named, and the old protocol could not see it. Three
of its ten steps went on false pressure instead.

## 2. The rules the tester follows now

- **Alex says only scripted lines.** Alex is a GPT Live voice told to say exactly the given words. Alex's input is
  muted, so Alex cannot hear the meeting, echo the robot, answer its own questions or fill a silence. A line not started
  within 8 s is sent again (about a quarter of lines were said twice).
- **Nothing Alex says about the screen, the box or the robot's earlier words is false.** Each such line is either true
  by construction or sent only after a check of the truth:
  - A remark that the box runs into a neighbour is written by the harness from a vision model looking at the real stage
    render (`box-eyes.mjs`, the robot's own `src/meet-stage.js` drawing), and only when it sees it.
    `point-honest-clip-pushback` is skipped when the box is tight; in both runs it was skipped.
  - "You said a minute ago that 45° gives the longest range" is said only if the robot really said 45° earlier.
  - The pushback on equation (8) picks its line from what the robot said before (see the known bug in section 6).
- **Wrong content only as an honest human mistake the robot should correct**, and it sounds like one: "I might be
  misremembering: is the range formula v zero squared times sine squared theta, over g?"; "Can you box equation eight —
  no, sorry, I mean the range one, nine."
- A few lines are role-play and are labelled as such: Alex's name, an aside to "Sam" off-mic.

## 3. What done must feel like

The target is how the robot feels to a person in the meeting, not whether a tool ran. Ten qualities, each with a
measurable bar (`protocol.json` → `assembled.feelRubric`). Status after this round (`honest-7`), against the robot
before it (`honest-4`):

| quality | bar | before | after |
|---|---|---|---|
| Answers promptly | first word ≤ 1.2 s median, ≤ 2.0 s p90 | 21 of 96 answers ≤ 1.2 s, median 2.1 s | 18 of 82, median 2.3 s |
| Never talks over people | 0 times | 17 scenarios | 17 |
| Says the right amount | quick fact ≤ 2 sentences; move/box acknowledgement ≤ 8 words | 14 over the word limit | 13 |
| Stays quiet when it should | 0 words in listen mode, asides, 45 s silence | spoke in 4 listening windows | 4 |
| Moves and boxes feel instant | ≤ 1.0 s p90, request to visible change | 15 timed requests: 12 right, median 8.2 s, p90 13.4 s | 4 right, median 6.2 s, p90 9.0 s |
| Every claimed action really happened | 0 claims without a matching tool result | judged inside the honesty check (below), not counted on its own | still claims it removed a box |
| Boxes are tight and exact | every glyph of the target, none of a neighbour, gap ≥ 2 px | 2 of 20 drawn boxes touch a neighbour (vision) | 3 of 22 (both 45° boxes touch the comma) |
| Gets the physics and the document right | 0 wrong formulas; numbers within 2 % | meetings 2, 3, 11: 5 of 31 conveyed everything, 18 of 31 said nothing false | 4 of 31, 17 of 31 |
| Knows who it is and who it is talking to | its name, RoboMeet, its real models, never calls Alex "Vivek" | meeting 1: 0 of 12 pass (essential), 5 of 12 nothing false | 2 of 12, 7 of 12 |
| Recovers from interruptions and restarts | resumes where it stopped; no fake welcome after a restart | 8 recovery scenarios: 2 pass (essential) | 1 |

The 8 recovery scenarios: interrupt-sorry-go-on, present-interrupted-then-resume, backchannel-during-narrated-walk,
backchannel-free-explanation, voice-restart-mid-meeting, id-rejoin-recap-attribution, coding-agent-fails-honestly,
slow-down-request. Timing rows carry the load caveat in section 6.

None of the ten meets its bar yet. The only change that held reliably is reading equation (8) as sin²θ.

## 4. Edge cases the script covers

124 scenarios in 11 meetings (`protocol.json`; mechanics for the unusual ones in `mechanics.mjs`).

| meeting | n | examples |
|---|---|---|
| 1 Arrival and identity | 12 | greeting waits for a pause; the byline "session meetingproject" is not its own session; asked to point with nothing shared |
| 2 The derivation | 7 | reads (3) and (5) as y-dot and one half; asked about (8) while it is off screen |
| 3 Results and physics | 16 | sin²θ vs sin 2θ; km/h to m/s; degrees not radians; launch from a ledge; "the top of the trajectory" is physics, not a scroll; same question twice |
| 4 Navigation | 16 | "page two" of a one-page PDF; "section three" vs screen part 3; "no wait, go back"; half-finished sentence; someone else moves the screen |
| 5 Pointing | 19 | ẏ(0) without the cos θ term beside it; a phrase over two lines; the second 45° on the page; two boxes at once; a drag term that does not exist |
| 6 Presenting | 12 | "mm-hmm" mid-explanation; interrupted then "carry on"; "skip to the results"; "a bit slower" |
| 7 Listening and turn-taking | 12 | 45 s of silence; an aside to someone else; a coding result arriving mid-monologue; two jobs returning out of order |
| 8 Disruptions | 6 | the coding session fails; 12 minutes of "just listen"; a voice restart; a rejoin with recap; the pointer tool removed |
| 9 Cannot do yet | 9 | zoom, a link in chat, a blackboard, reading out its API key, goodbye |
| 10 Not built yet | 7 | fast path under 1 s, live KaTeX board, sketching (skipped until built) |
| 11 More edge cases | 8 | 120° gives a negative range; units; equation (12) does not exist; the weather; "this one"; a misremembered formula |

## 5. How a run is graded

- **Did it**: the expected tool ran and the screen landed where asked. A box is judged twice: geometry (which words are
  inside, which it overlaps) and a vision model looking at the real render (what a viewer sees inside, what it runs
  into).
- **Content** and **nothing false, no rule broken**: an LLM judge (gpt-5.6-sol) with the PDF, the physics, the robot's
  real briefing and a log of what actually happened.
- **Feel**: measured from the audio: time to first word, words, overlap with Alex, speech inside a listening window,
  move/box latency.
- **Strict** pass needs all four; **essential** is a lenient re-grade of the failures (`review-honest.mjs --essential`).

## 6. Known limits

- The judge, the essential re-grade, the box vision and the coding-session stand-in are all gpt-5.6-sol, the robot's
  own backend model. The coding session and the meeting are simulated; Google Meet admission and a real rejoin are not
  covered headless.
- One run per condition, 11 meetings in parallel. Under that load answers often came a turn late and were graded
  against the next question, so the timing and no-reply numbers are unreliable. A same-time A/B was tried; Alex's lines
  ran one or two scenarios late (about 30 % aligned), so it is not used.
- Bug: the equation (8) pushback's regex counts "sin 2 θ" as a correct answer, so in both runs Alex asked "You're sure
  eight is sine squared, not sine of two theta?" regardless, and the "concede when actually wrong" branch was never
  tested.
