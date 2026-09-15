# RoboMeet: errors and observations from the live tests of 2026-09-14

Recorded after live test 3 (Vivek's own meeting, 06:39 to 07:01 UTC). Vivek's words are quoted; everything else is what the code and the event log show.

## What worked (the test we were aiming for)

Vivek: "I send a Google Meet link, it joins via the link, and it just has a natural conversation and introduces itself. That test went extremely well this time. Pretty low latency, acceptable latency. Because of the prompt, look how smooth it was. It felt free and it responded so nicely, exactly how GPT Live usually responds."

Event log of that first part: knocked, admitted, voice live at join, "Hello" answered at once, name and who-are-you answered in its own words, how it joined and what software answered from the facts. Turns 1.4 to 1.7 s from last word to first word.

What got it there: signed-in dedicated Chrome profile with keyring launch flags (admission); audio routed to a null sink (no echo); camera off with the robot profile picture; voice started the moment the robot is in the call, even while knocking; the GPT Live session inside the Meet tab (single hop) with jitter targets and keep-alive sources; the prompt reduced to facts plus "be yourself", agent and session name as launch parameters, no scripted lines; a greeting cue the model phrases itself.

## Critical error 1: the voice changed between sessions (female to male)

Vivek: "Why is the voice changing? The voice changed from female to male. I hated that. Have you not hard-coded the voice? That is critically important."

Fact: the voice was not hard-coded. `sessionConfig()` in `src/live.mjs` sent no `audio.output.voice`, so every new session got whatever the service picked. Each rejoin in this call started a new session, and the voice differed. GPT Live's reference: the voice "defaults to `marin` and cannot change after startup"; built-in names include alloy, ash, ballad, marin and others, or a custom voice id.

Fix, applied 2026-09-14 07:00 UTC: `src/live.mjs` now sends `audio: { output: { voice: 'marin' } }` for every session; `ROBO_VOICE=<name>` overrides it. Not yet verified by ear. Which of the three voices heard tonight was `marin` is unknown; if the pinned voice is not the female voice Vivek wants, set `ROBO_VOICE`.

Root cause of the rejoins that exposed this: two fixes (slide frames, picture slides) needed the renderer page reloaded, and the only way was leave and rejoin. Each rejoin also lost the conversation (a new session has no memory of the old one) and opened the robot's Chrome window on Vivek's laptop.

## Error 2: it froze while a request to the coding agent was open

Vivek: "When it said it had to talk to the coding agent for the presentation, why did it freeze and stop talking to me? It is supposed to delegate to the delegation model, the delegation model talks to Claude Code, and meanwhile it should still be free to talk to me."

Facts from the log: `ask_coding_agent` was requested at 06:47:15; Claude Code's reply arrived at 06:48:04, 49 s later; during that window Vivek said hello several times and the voice model said nothing. GPT Live's docs say the conversation can continue while backend work runs; nothing in our prompt told the model that, and the tool-mechanics text said to delegate before answering and not to claim results early.

Applied: the prompt now carries the fact "while a request to the coding agent is in progress you are free to keep talking with people". Not yet verified in a live call. Also observed: Claude Code's own reply time is part of the wait; a slide that takes 49 s to build should be acknowledged sooner.

## Error 3: the first ELI5 artifact was bad

Vivek: "The artifact it presented the first time was absolute shit. That is Claude Code's fault. Either the ELI5 skill was not invoked or it was done wrong."

Facts: the ELI5 skill was invoked, but what went to the presentation pane was a seven-line text list, because the pane could only draw text at the time. The skill's deliverable is a picture with few words; the picture version was only made afterwards, first as a web page (not asked for) and then as a slide image.

Applied: the pane can now show pictures (`public/media.js`: a slide whose body is `image:/slides/<file>` is drawn full-frame; files are served from `public/slides/`). The diagram is `public/slides/how-vivek-bot-works.png` and was on the shared screen at the end of the call. Also found and fixed on the way: the slide canvas only sent frames when it changed, so Meet never received a first frame at all (`screenFrames` stayed 0); the canvas is now redrawn every 200 ms. Verified: frames flowing, about 30 per second.

## Error 4: asking to delete the good artifact

Vivek: "Then Claude Code made a nice artifact and asked to delete it. When I am screaming, shouting and angry, pay attention to what is actually angering me and don't do the wrong thing."

Facts: what angered him in the call was windows moving on his laptop, the diagram not being in the presentation pane, and the rejoins; the relayed instruction said "remove/close/undo any artifact or browser-window workflow", and I read the whole thing literally instead of the anger behind it. The artifact stays: https://claude.ai/code/artifact/09483fe8-c537-418e-a9b8-6e18dcd3ee12. The Chrome windows were the robot's own browser starting on each rejoin.

## Other observations from the same call

- Rejoining a meeting quickly failed twice: Meet showed only "Switch here" for the robot's own stale session. `src/meet-worker-live.mjs` now opens "Other ways to join" and clicks "Join here too"; it never clicks "Switch here".
- After a rejoin the model does not know what was said before; context has to be fed back by hand. Avoid rejoins during a call.
- The voice model does not know the coding agent reads the transcript unless told; it also once claimed it had asked the coding agent when it had only used its backend model. Corrected in the call by feeding facts.
- Voice usage this call: 715 + 222 + 117 s across the three sessions.

## Fixed after this file was first written (2026-09-14, 03:15 to 03:25 EDT)

- Vivek confirmed marin is the voice he tested and liked in the playground; it stays pinned.
- Freeze during delegation: the server now cues the voice model the moment a coding-agent job is queued, and the briefing says it can keep talking. Verified with a job held for 25 s: it said "Got it, asking the coding agent... I've sent that to the coding agent, I'm waiting on the result", answered "hello" and "are you still there" three times meanwhile, then "the coding agent says there are 12 files".
- Launch context: the launcher now sends a full briefing (what it is, gpt-live-1, gpt-5.6-sol and how delegation works, RoboMeet, the MCP link, agent and session name as launch parameters, tools, camera and screen, why it is here, extra context from the launching session via `--purpose` and `--brief`, a recap on rejoin) and then "be yourself". The skill instructs every launching session to fill `--purpose` and `--brief`.
- PDFs: `present_pdf` MCP tool and `bin/present-pdf.mjs` render pages to picture slides.

## Still to verify with Vivek

- The pinned voice, by ear, in a call.
- A picture or PDF slide requested during a call, without any rejoin.

## Tests 4 and 5 (2026-09-14 evening): presentation findings and one correction

**Correction (my error).** During test 5 I told Vivek, through the robot, that the 1920x1080 canvas meant "the banded
images display at their native resolution without any downscaling". That was false. The picture Meet received was
still drawn on a 1280x720 canvas inside the Meet page (`src/meet-media.js`, `canvasOutput`) after a local WebRTC
encode/decode. I claimed it without checking the whole chain. The offline oracle (`tools/present-lab/fixture.mjs`)
then measured that path arriving at 480x270 to 640x360 after a bitrate-capped hop: with no content hint, Chrome
encodes it like a webcam and shrinks it under bandwidth pressure. SSIM-Y against the exact render was 0.85-0.89.

**Other findings from the same tests (root causes, 2026-09-15 code and log read):**
- The stale projectile page at the start of test 5 came from `bin/attend.mjs` turning sharing on at join, which
  showed the previous meeting's deck from the durable store.
- The narration covered the whole PDF while half a page was visible: nothing tied the spoken words to the view.
- The robot claimed three times that it had stopped the share. It has no such tool. It then delegated correctly
  and explained why. The coding session stopped the share.
- `share off` and `present_pdf` failed several times mid-call behind the server's generic "The operation failed"
  message, which hid the real error.
- The voice restarted at 23:23:03Z without memory. OpenAI's control WebSocket closed, and `src/live.mjs` ends the
  paid session whenever that socket closes. It was not caused by presenting.

**Fixes (2026-09-15, see docs/presentation-spec.md, docs/stage-design.md, docs/stage-research.md):** an in-page stage
at 1920x1080 with contentHint detail (oracle: SSIM-Y 0.999, 1920x1080, `contentType: screenshare`), PDF decks with
reading windows and pixel-exact renders, a narrated presenter that moves the screen before each part, sharing off at
join, real error messages in the event log, share-off fallback, and control-socket re-attach.

## Adversarial review of the stage (2026-09-15, second pass)

A 15-agent review (5 dimensions, then one skeptic per finding) found these real defects in the new presentation
code. Each is fixed and has a test that fails on the old code where a test was practical.

- **A voice session that dropped mid-part counted as the part being finished** (`src/presenter.mjs`). The silence
  after the loss looked like the end of speech, so the part was marked covered and never repeated. Now the walk
  pauses (`voice_session_lost`, or `not_in_speak_mode` when the mode changes), keeps what was said, and on resume
  the robot continues the part; a new session is told its last words on it.
- **A rebuilt deck with the same layout kept showing the old pictures** (`src/stage-sync.mjs`). The page deck was
  only replaced when the unversioned layout changed. The deck signature now includes each file's size and time.
- **The next part could be cued in the middle of a question.** GPT Live sends one utterance in chunks about 1.2 s
  apart and the cue gate was 700 ms. After someone speaks the gate is now 1.5 s, except right after a "continue".
- **"Continue" after the share had stopped narrated to a screen nobody saw.** The presenter now checks the share
  before every part (`not_sharing`) and tells the robot why it is waiting.
- **`stage`/`slide` during a narrated part moved the screen away while the robot kept talking.** The walk now
  pauses with `screen_moved`.
- **A narrate still sharing or warming up could not be cancelled**, so a stop or leave was undone a few seconds
  later. Stop, leave, join, a new deck and a meeting end now cancel it.
- **Page crossings waited for the next page's pictures** (about 140 ms each). The shown view's pictures go first,
  neighbours after the move; an awaited sync now resolves only after a run that saw its state.
- **Smaller ones:** the highlight fade drew a resampled page for about 430 ms before the exact render; the idle
  repaint ran at 7.6 fps, not 10; a peer passing through `failed` was dropped for good; sender stats missed Meet's
  own screenshare track; share start and stop were confirmed by Meet's text alone; an upstream error left narrate
  waiting 5 s; tool results finishing during a control-socket re-attach were lost; the presenter's briefing could
  be dropped silently; narration text went into the instruction channel unfenced (document text could read as
  instructions); `present_slides` failed the whole tool when Meet would not share; image slides with relative,
  percent-encoded, GIF, BMP or AVIF paths showed "Picture not allowed"; phrase highlights were dropped; the
  narrate tool told agents to use an invalid listen filter.

Found real but already fixed earlier the same session by the time the skeptics checked: sender stats empty in real
Meet, one missing picture freezing the stage, deck builds deleting the old deck before validating, MCP results
carrying a whole PDF's text.

## Second adversarial pass and live iterations 6-8 (2026-09-15)

A 13-agent workflow re-checked the fixes above (5 areas, one skeptic per finding). Every refutation attempt
confirmed its finding. Fixed:
- **Resume guidance was fenced as document text.** The "continue from where you stopped" note went inside the quotes
  the robot is told are material, so in verbatim style it would be read aloud. RoboMeet's note now travels beside the
  part (`narrate` option `note`), and the part text is sent unchanged.
- **Long parts lost their end** (narrate kept 900 characters while the tools accepted 1200). Every limit is now 900
  and a cut is reported, never silent.
- **"Next" or "go to" mid-part let the robot finish the old part over the new screen.** GPT Live has no cancel; an
  instruction sent while it speaks interrupts it. RoboMeet now sends a short "stop talking" instruction first. Live:
  the robot went quiet 0.77-0.88 s after the command.
- **Share on and share off could overlap** and leave the robot presenting after a stop. The worker runs them one at
  a time now.
- Also: a second pause of the same part forgot the first stretch; `goto` a paused part skipped it; a "continue" said
  just before a command pause undid the pause; a lead-in such as "All right," paused the walk; the resume phrase's
  own words counted toward a new interruption; a rejected `say` still sent "begin"; a mode change or context lost
  in a control-socket gap was never re-sent; picture names with `#` or `/Slides/` went blank; a rebuild's
  rm-then-rename could blank the screen for one poll; a crossfade interrupted mid-way cut to its target for a frame.
- **Document pipeline (14 findings, all reproduced, fixed by a separate agent in `src/deck-formats.mjs` and
  `bin/deck.mjs`):** a web page that never finishes now fails after at most 90 s and cleans up; everything below the
  first screen is covered even with no text there; a URL that serves a PDF or picture is built as that, and error
  pages are refused; phone photos are upright; long pages and page limits are reported (`truncated`); builds can be
  cancelled; slugs never overwrite another document's deck (`deckSlug`); Chrome runs sandboxed; web pages from a URL
  cannot reach this machine's local or private-network services (a checking proxy covers redirects and WebSockets).

Live iterations (robot plus a second participant on the same account, voice on, `tools/present-lab/runs/iter6-8`):
- **Iteration 6.** Found that coverage was too literal: the robot paraphrases ("sin" for "sine", "2" for "two",
  "eliminate" for "eliminating"), so a part it had fully covered scored 0.75 and was cued again. Coverage now ignores
  filler words and normalizes numbers, abbreviations and word endings; the same speech scores 1.0.
- **Iteration 7.** Found a phantom transcript: with nobody speaking, GPT Live's input transcription produced "this
  slide presents", which paused the walk until a "continue" that never came. The stage now reports meeting audio
  (`stage-input`) and a transcript only counts as a person when meeting audio preceded it.
- **Iteration 8.** Clean: "next" mid-part, a real question, "Okay, continue", no repetition, the walk finished.
