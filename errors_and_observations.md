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
