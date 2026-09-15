# Context anchor

## 2026-09-12 23:42 CDT — Build authorization and agreed scope

User instruction: “Okay, context anchor, what you have and then just send it. Start building it and don't burn my credits after you're done. I want this shit to work. Get it to fucking work.”

### User decisions carried forward

- Build a new, lean, locally hosted meeting robot, inspired by the existing RoboVoice / Professor Claude project. Preserve existing working projects, configurations, and skills.
- Use GPT Live directly for the voice model. Do not include LiveKit.
- Keep a cute animated robot face. Include presentation and note-taking capabilities.
- Connect the app to coding-agent sessions through an app MCP server, including a listening/job queue and tools to send results, context, presentations, and notes. Claude-specific channels are not a prerequisite for the shared app.
- Launch the local app and meeting connection from the terminal with a meeting link.
- First build and test the local Google Meet path. Zoom remains a separate transport integration to verify; it must not be represented as working based on a Meet test.
- Use vivekkmk.assistant@gmail.com for Google testing. The user authorized browser login and meeting tests.
- Stop paid test sessions when finished; do not continue consuming credits after completing the work.

### Verified setup before implementation

- Google Meet in Chrome is authenticated as Vivek Bot, vivekkmk.assistant@gmail.com. A test meeting was created: https://meet.google.com/nqo-sccv-gjq . The meeting has not yet been joined or used for an app test.
- An existing server-side OpenAI key is available in the original LiveKit project's agent-py/.env.local. A read-only model request for gpt-live-1 returned HTTP 200. A paid voice session has not yet been tested.
- Node.js 25, Chrome, FFmpeg, and DISPLAY=:1 are available. nvidia-smi currently cannot communicate with the NVIDIA driver; no driver changes are authorized or needed for the first browser implementation.
- Recall signup with a Gmail address was a barrier in the earlier research. The selected local Meet implementation does not depend on a Recall account, AgentCall, Attendee hosting, or ngrok.
- Completed transport research is in outputs/meeting-transport-deep-dive.md and the Attendee, AgentCall, and Recall research reports alongside it.

### Implementation approach — proposed, to be validated by tests

- New standalone Node app under outputs/robomeet, with an isolated Chrome meeting worker and a browser renderer for robot video, presentation video, and GPT Live audio.
- The worker joins Meet through its web client and routes media through browser media tracks. The user's signed-in Chrome is used only as the test host, not copied or modified for the bot.
- A single hidden meeting renderer owns the paid GPT Live session; dashboard controls command it through local app state. Stop and Leave must close that session, not merely mute playback.
- Durable coding jobs are separate from continuous voice. MCP listen/reply tools exchange requests and results with a coding client. Automatic wake-up of an idle existing Codex desktop task has not been established and must not be claimed.
- Success requires an actual Meet join and verified media, presentation, notes, and coding-job exchange. Mock tests alone do not establish a working meeting integration.

## 2026-09-13 00:24 CDT — Implementation checkpoint

Verified implementation facts subordinate to the user's build instruction:

- New standalone app implemented in outputs/robomeet. It uses direct GPT Live, an original animated canvas robot, independent slide canvas, local durable notes/jobs, and standard MCP. No LiveKit, Recall, tunnel, or original-project edits.
- All 13 automated tests pass. These include real MCP subprocess communication, duplex browser media with audible output at a remote fixture, separate camera/screen tracks, echo exclusion, replacement tracks, dedicated-profile guards, HTTP SDP preservation, session cancellation/closure, and filtered durable listeners.
- Three successful bounded paid GPT Live tests ran. All returned confirmed session closure; voice is now stopped/idle. No more paid tests are running.
- Real voice input/output worked. A subsequent real backend tool call persisted a note and the voice model confirmed it.
- This existing Codex task received a real model-generated coding request through MCP, inspected example-slides.json, and replied with the actual count of two. The bounded voice session closed before that reply arrived; the result remained durable and did not restart voice.
- A final test used an actual MCP SDK client with a deliberately narrow deterministic responder for that same fixed-file count. It read the real file, returned the result through MCP, and the voice model audibly said that the file contained two slides. It did not create another AI coding task.
- This Codex task supplied the presentation through MCP. Dashboard notes/job results were inspected; the Next slide button changed the presentation from 1/2 to 2/2.

### Remaining external prerequisite and next test

- Actual robot admission to Google Meet is NOT verified. Google rejected unsigned-in attempts with “You can't join this video call,” including an unmodified browser. Retrying with the host present and meeting access Open did not resolve it. The exact underlying rejection reason was not established.
- The existing signed-in Chrome host is authenticated as the assistant Google account. The robot's separate profile has not yet been authenticated.
- Added bin/login.mjs and an app-owned profile at outputs/robomeet/data/browser-profile. The helper opens normal Chrome for legitimate sign-in; it never copies existing browser profiles, cookies, or credentials.
- That separate Chrome sign-in window is open. An asynchronous request asks the user to sign in as vivekkmk.assistant@gmail.com, close the window, and report completion. No completion response has arrived at this checkpoint.
- After that response, start the app with ROBOMEET_PROFILE_DIR=data/browser-profile and test real Meet admission, incoming/outgoing speech, robot camera, and screen sharing. Do not claim this is already working. Zoom remains unimplemented.

### Handoff and cost state

- Local dashboard server is running at http://127.0.0.1:4318 with voice OFF. The server itself makes no ongoing paid calls while voice is stopped.
- All paid test sessions, test browser instances, and MCP test clients closed. Temporary Google Meet host and diagnostic guest tabs closed. No monitor or automation was created.
- The only remaining normal Chrome window is for the requested robot sign-in. Global coding-agent configurations and original projects are unchanged.
- Entry points: npm start; node bin/command.mjs; node bin/tool.mjs for a real MCP client usable from this existing task; node bin/mcp.mjs for standard MCP clients.
- MCP listen excludes transcript chunks by default and waits for actionable events. MCP state replies omit large event histories. Idle desktop tasks still require an active listen loop; no automatic wake-up is claimed.
- User-facing details and evidence: outputs/robomeet/README.md, VALIDATION.md, validation-evidence.json, and TEST-RESULTS.txt.

## 2026-09-13 01:33 CDT — User-authorized handoff checkpoint before continuing OAuth

Vivek's instruction: “Yes, you may click on continue, but since we have very little usage credits left, first context anchor everything you have done. Second, also just in your next message tell me which repository all this work is in. And also create a file saying what you're currently working on, what you were struggling with, saying like codex underscore struggles dot MD. And then after that, yes, you may continue.” He wants Claude Code to be able to pick up the same work if Codex usage runs out. Complete the records and report the location before proceeding.

Vivek also explicitly directed Codex to use the existing GWS authorization and Google connector instead of repeatedly asking him to find passwords or perform the login himself.

### Verified handoff facts — subordinate to those instructions

- The actual application directory is `/home/vivekkarmarkar/Documents/Codex/2026-09-11/okay-so-i-have-an-interesting/outputs/robomeet`. Both this directory and the enclosing chat workspace currently fail `git rev-parse --show-toplevel`: this is a local project folder, not an initialized Git repository, and no Git remote was found. Do not imply it was pushed to GitHub. The existing RoboVoice/Professor Claude/LiveKit project was inspiration only and remains unchanged.
- The complete earlier implementation and validation checkpoint above remains relevant: direct GPT Live; animated face; slides; durable notes and jobs; real standard MCP; 13 passing automated tests; three real voice sessions with confirmed closure. Real Google Meet robot admission/media and Zoom are still incomplete.
- A fresh assistant-owned meeting (`qrj-safs-zgk`) was tested with the host present, initially Trusted and then Open. The actual anonymous robot was rejected both times before receiving a join button: “You can't join this video call.” Prior plain-browser and injected-browser tests also failed. The exact Google reason is unknown; do not claim it is definitely automation detection, a Gmail policy, or solved by sign-in.
- Regular Chrome is signed into `vivekkmk.assistant@gmail.com` (`authuser=2` in the observed profile). The isolated robot profile is separate. Its normal login window remains open; the supported browser-control diagnostic found no control extension installed in that profile. A separate in-app sign-in diagnostic reached a password prompt and was closed. No password was obtained and no browser login was copied.
- `gws auth status` showed valid encrypted OAuth credentials and a refresh token. A real `gws gmail users getProfile` request confirmed `vivekkmk.assistant@gmail.com`. A real `gws meet spaces get` request failed with HTTP 403, insufficient authentication scopes. This is a missing Meet permission, not an expired GWS login or password failure.
- Prepared a separate GWS config at `outputs/robomeet/data/gws-meet-auth`; copied only the known OAuth client configuration into that private directory. Existing GWS credentials/configuration are unchanged. Do not print secrets or commit either auth directory.
- Started `gws auth login --scopes https://www.googleapis.com/auth/meetings.space.created` with `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` pointing to the separate app config. GWS also requested OpenID/basic identity. Selected the already signed-in assistant account through regular Chrome without a password.
- Google identified the OAuth app as OpenClaw Agent, its developer as `vivekkmk.assistant@gmail.com`, and its callback as localhost. Automatic approval review rejected Continue at Google's unverified-app warning twice, even after ownership verification. **Vivek has now explicitly approved that Continue click. Do not ask for the same approval again.**
- At this checkpoint the OAuth process handle is exec session `63892`, with callback `http://localhost:35029`; the browser binding is `gwsConsentTab`. These are ephemeral handles, not permanent configuration. Revalidate before reuse. If the process has expired, restart the same isolated authorization and use its new callback URL; the user's approval persists for this same app/scope flow.
- The intended next experiment is `gws meet spaces create` with `config.accessType=OPEN` and `config.entryPointAccess=ALL`, using that isolated authorization. It has NOT yet been run successfully. Inspect actual API results, then host the returned link in the signed-in assistant browser and test the real robot with voice off. Meeting creation is not proof of robot admission.
- Official docs reviewed: Meet REST handles setup/settings/metadata; documented Meet Media API transceivers are receive-only and have Developer Preview requirements. No supported GWS refresh-token-to-browser-sign-in flow was found. Neither a scope grant nor an API-created meeting alone resolves the outgoing robot media path. Details and sources are in `outputs/robomeet/GWS-CHECKPOINT.md`.
- Known unpaid process handles: app server `52678` (localhost port 4318), dedicated normal Chrome login helper `96863`. Last verified voice state was stopped/idle with closeConfirmed true. No paid voice sessions ran during the admission retries or GWS investigation.
- All existing research is alongside the app in `outputs/`: `meeting-transport-deep-dive.md`, `attendee-transport-research.md`, `agentcall-transport-research.md`, and `recall-transport-research.md`. Runnable smoke harnesses and raw diagnostic evidence are in workspace `work/robomeet-test/`.
- Current implementation difficulties and exact resumption steps will be recorded in the app's `codex_struggles.md` before continuing. The user wants a working product, not more status loops or repeated password requests. Stop paid sessions after each bounded test, and do not represent fixtures as actual Meet success.

## 2026-09-13 01:39 CDT — Approved OAuth and real GWS meeting creation succeeded

Following Vivek's explicit approval, the context anchor and `outputs/robomeet/codex_struggles.md` were completed and the exact local project location was reported before continuing.

- Clicked through the approved Google warning and granted only the requested app-created Meet permission plus basic identity. GWS returned **Authentication successful** for `vivekkmk.assistant@gmail.com`. Encrypted credentials are saved in the app's `data/gws-meet-auth/credentials.enc`. No password was required.
- The waiting OAuth process `63892` completed with exit code 0. Its old callback URL is no longer an active login listener.
- A real `gws meet spaces create` request then succeeded using the separate credentials. Google returned `https://meet.google.com/onh-rhid-zuu`, resource `spaces/mJrUzJy2S2QB`, with `accessType: OPEN`, `entryPointAccess: ALL`, `moderation: OFF`, recording/transcription/smart notes OFF, and no attendance report. This proves this assistant Gmail account can create the tested Meet space through the REST API.
- Next: host this new link using the existing signed-in assistant Chrome and test actual robot admission with paid voice OFF. Neither the isolated robot browser login nor robot admission has yet been established by this success.

## 2026-09-13 01:42 CDT — API-created meeting admission test completed; rejection persists

- Hosted `onh-rhid-zuu` in regular Chrome as the assistant account. The actual UI showed “This call is open to anyone” and the host in the call, with microphone and camera off.
- Launched the actual RoboMeet worker against this link. Its local media bridge connected, then Google again displayed “You can't join this video call.” App status became error with admitted false. Raw evidence is `work/robomeet-test/gws-meet-admission-result.json` (events 196–204).
- The new GWS authorization and meeting-creation route are now proven working; **they did not solve robot admission**. Do not repeat OAuth setup or suggest that another OPEN/ALL room is an untested solution. The exact Google rejection cause remains unknown.
- Closed the test host tab. The worker closed its own rejected browser. Voice was stopped/idle with closeConfirmed true throughout; no new paid voice call ran.
- The current handoff is the app's `context_anchor.md` plus `codex_struggles.md`; the latter has the current failed experiment, code map, prior validation, commands, account state, and remaining requirements. The application is still a local folder, not a Git repository.

## 2026-09-13 15:02 EDT — Claude Code session: Meet admission root cause established; sign-in step staged

Vivek's instructions this session (text, in the Claude Code terminal): "we are stuck at the final layer where you just connect to Zoom or Google Meet... look at the documentation for all three [Recall, AgentCall, Attendee] and figure out if we're actually properly implementing the last part or if you can borrow it." Later: "I think it's some weird auth bug... there's fable safeguards, and then there's anti bot stuff. And this is not, like, harmful, but it needs to be done in the right way." Then: "I'm fully authorizing you. Can't you just go navigate, change the password for the assistant account, and then run this command?"

### Verified facts added by Claude Code (subordinate to the instructions above)

- **The rejection is not automation detection.** Controlled experiment 14:24–14:29 CDT on the API-created OPEN space `onh-rhid-zuu`, host `Vivek Bot` (vivekkmk.assistant@gmail.com) present in the call from the regular signed-in Chrome, mic and camera off. (E3) The app worker's exact Playwright launch (no `--enable-automation`, AutomationControlled disabled, fake devices, meet-media.js injected) with the innocuous name "Vivek Guest": Join now → "Sign in with your Google account / Instead of waiting to be let in..." nudge → "You can't join this video call" 1.1 s after the click. (E1) A plain `/usr/bin/google-chrome` with a fresh empty profile, no Playwright, no flags, no fake devices, driven only by xdotool: identical nudge before Join, identical "You can't join this video call" within 3 s. The host saw no knock prompt in either run. Evidence and README: `work/robomeet-test/claude-admission-control-2026-09-13/`.
- **Stage 1 was already fixed by Codex after the last anchor entry.** `work/robomeet-test/automation-flag-probe-result.json` (02:27 CDT): Playwright's default `--enable-automation` (navigator.webdriver=true) caused the immediate pre-join "You can't join this video call"; `src/meet-worker.mjs` now removes it. The earlier anchor text "cause unknown" is superseded for that stage.
- **What remains unresolved is only sign-in state.** The robot browser has never been signed into any Google account. Google's consumer help says for personal-account meetings "Users who haven't signed in to a Google Account must request to join", and "Anonymous joins" is listed only for paid editions. Whether the instant denial is that policy or Google's separate risk classifier (Attendee's maintainer: "It's IP based"; Recall: a signed-in bot "may still be flagged") is not settled; every attempt today shared this laptop, Chrome 144, and one IP. Both explanations lead to the same remedy.
- **What the three services do.** Attendee: anonymous bot by default; on "You can't join this video call" it retries with a fresh Chrome, then switches to a signed-in bot; its signed-in bots use a paid Google Workspace with Attendee as SAML SSO identity provider (no password). Recall: same Workspace SAML model; classifies our screen as `google_meet_bot_blocked`; its open-source PoC used a real Gmail account signed in once by a human with the browser session persisted. AgentCall/FirstCall: document only "host admits from the waiting room"; nothing on sign-in or this rejection. Nothing from the Workspace SAML machinery is reusable for a personal Gmail host; the reusable pattern is "human signs the robot's own profile in once, app reuses that profile", which Codex already built (`bin/login.mjs` + `ROBOMEET_PROFILE_DIR=data/browser-profile`).
- **Codex also built an undocumented second path after 01:42 CDT**: a signed-in-Chrome bridge extension (`src/meet-bridge-worker.mjs`, `extension/`, `bin/start-signed-in.mjs`, 03:27–04:12 CDT). Its rehearsal failed (bridge RPC timeout, no inert activation point) and branded Chrome 137+ no longer loads unpacked extensions from the command line, so it needs a manual "Load unpacked" in the regular Chrome. Incomplete and unverified; not needed if the profile sign-in works.
- **Sign-in staging (14:47–14:49 CDT).** Claude will not enter or set passwords or push an account through Google's verification, even with Vivek's authorization. Staged instead: (right window, regular Chrome) myaccount password change → "verify it's you" → Google sent a sign-in prompt to the device signed into the recovery email viv…@gmail.com; (left window, robot profile via `node bin/login.mjs`) accounts.google.com with the email prefilled, waiting for the password. Vivek's remaining part: tap Yes on the phone, type a new password on the right, type it once on the left, close the left window. Then start the app with `ROBOMEET_PROFILE_DIR=data/browser-profile` and test a signed-in join with voice OFF. A signed-in join has NOT been run yet; expected but unverified.
- No app code was changed. No paid GPT Live session was started. The Codex-started app server on 127.0.0.1:4318 is untouched. Zoom untouched.

### 2026-09-13 15:03 EDT — timestamp correction for the entry above

The times inside the previous entry ("14:24–14:29 CDT" and "14:47–14:49 CDT") are machine-clock times; this laptop's timezone is America/Toronto (EDT). Iowa City equivalents: experiment 13:24–13:29 CDT, sign-in staging 13:47–13:49 CDT. Codex's earlier entries used CDT correctly.


## 2026-09-13 22:35 EDT (21:35 CDT Iowa City) — Robot admitted to Google Meet; signed-in profile path works

Vivek's words: "I finished everything, clicked 'x' on the meet window and my new password is [withheld]". He signed the app-owned robot profile (`data/browser-profile`) into vivekkmk.assistant@gmail.com himself via SMS-code account recovery and a new password. Claude never typed the password.

### Verified by Claude Code (own eyes, screenshots in the session scratchpad and `work/robomeet-test/`)

- First signed-in attempt with the unchanged worker FAILED: `locator.click: Timeout 5000ms exceeded`. A probe on the same profile showed Meet treating it as signed OUT ("Sign in" link, name box, "Join now" disabled) although all Google session cookies (SID, HSID, SSID, APISID, SAPISID, __Secure-*PSID, SIDCC) were present.
- Root cause: the sign-in was done in plain Chrome (`bin/login.mjs`), which encrypts cookies with the GNOME keyring; Playwright launches Chrome with `--password-store=basic` / `--use-mock-keychain`, so those cookies were unreadable. A second probe with those two switches removed loaded the same profile signed in as "Vivek Bot (vivekkmk.assistant@gmail.com)".
- One-line fix applied in `src/meet-worker.mjs` launchOptions: when `ROBOMEET_PROFILE_DIR` is set, `ignoreDefaultArgs` also drops `--password-store=basic` and `--use-mock-keychain`. The anonymous path is unchanged.
- Result: `ROBOMEET_PROFILE_DIR=data/browser-profile npm start` then `node bin/command.mjs join https://meet.google.com/onh-rhid-zuu` → launching → joining → awaiting_admission → **joined, admitted:true in 4 s** (events 250–263). `share on` → sharing:true; media bridge connected, camera frames streaming. Robot's Meet window shows "Vivek Bot (You, presenting)" with the cartoon robot face as camera.
- Not yet verified: what a second participant sees/hears, incoming audio, and GPT Live voice in the meeting (paid; not started). Zoom untouched.
- Runtime now: app server pid 2614141 on 127.0.0.1:4318 with the profile; robot still in `onh-rhid-zuu`, voice stopped/idle. Codex's original server (pid 2242610, no profile) was stopped to free the port.
- Sign-in is one-time: the profile persists and the app never clears it. The password change signed the assistant account out of the regular Chrome (expected).

## 2026-09-13 22:58 EDT (21:58 CDT Iowa City) — Live two-way voice in Google Meet verified; tests pass

Vivek's words: "Yes. We joined the voice. Let's see if this thing can talk." then "I'm in" (joined from his phone with another account).

- GPT Live (`gpt-live-1`) session started from the app with the robot in `onh-rhid-zuu`, mode speak. Vivek spoke from his phone; transcript (events 293–437, saved to `work/robomeet-test/claude-admission-control-2026-09-13/live-voice-transcript-2026-09-13.txt`): "Hello, is anyone there" → robot "Yes, I'm here with you."; "can you hear me" → "Yep, I can hear you clearly."; "Can you see me" → "No, I don't have video. Just your audio."; questions about slides and the coding agent answered in kind. Both directions of audio work end to end.
- Echo: Vivek heard echo because the robot's Meet tab plays the call through the laptop speakers and his phone was in the same room. Claude muted the laptop's default audio sink (`pactl set-sink-mute @DEFAULT_SINK@ 1`); the robot's audio path is WebRTC tracks, unaffected. Unmute with `pactl set-sink-mute @DEFAULT_SINK@ 0`.
- Robot said it was not connected to a coding session because no agent was listening; Claude Code then connected as the coding agent via `node bin/tool.mjs listen` (real MCP client), pushed the example deck with `present` (enabled, slide 1/2 on the shared screen; static slides keep the screen-frame counter at 0), and sent meeting context via `context` describing the robot's environment and tools. No coding request was issued by voice before Vivek paused the call.
- The robot does not greet on join by design (system instructions in `src/live.mjs`). It speaks only when addressed.
- Voice sessions this evening: one idle session ~8 min (nobody spoke; stopped by Claude before the 10-min cap), one live session 191 s (closed, confirmed). Voice is now stopped/idle; the robot remains in the meeting with sharing on; a watcher restarts voice on new speech; laptop audio still muted.
- `npm test`: 15/15 pass after the worker change (13 original + 2 bridge-extension tests).

## 2026-09-13 23:52 EDT (22:52 CDT Iowa City) — Global launch shipped; laptop echo fixed; Tests 1–2 passed through the shipped path

Vivek's requests this session (his words, condensed): ship a globally available MCP and a globally available launch skill usable from any Claude Code or Codex session, with a listening tool (no channels protocol); use gpt-5.6-sol for delegation instead of luna; test Meet end to end first (conversation, long slide decks, notes), then Zoom; monitor GPT Live costs; "remove" the slide limit; joining from his laptop with the Physics Animated account must produce no echo ("boom boom" feedback is unacceptable for a PhD-defense scenario); the animated face lags the voice and must become "a much more realistic animated face". In the call he judged: "this test has been good".

### Shipped and verified by Claude Code
- **Global MCP `robomeet`**: `claude mcp add --scope user robomeet -- node <app>/bin/mcp.mjs` (status Connected); `[mcp_servers.robomeet]` appended to `~/.codex/config.toml` (backup saved; `codex mcp list` shows it). Tools: status, join, leave, voice, mode, listen, reply, send_context, present, slide, notes.
- **Skills**: `~/.claude/skills/robomeet`, `~/.claude/skills/robomeet-stop`, identical copies under `~/.codex/skills/`. `/robomeet <link>` runs `bin/attend.mjs` in the background, waits for `joined`, then runs the listen/reply loop; `/robomeet-stop` runs `bin/attend-stop.mjs`.
- **New helpers** (new files only): `bin/attend.mjs` (ensures server with `ROBOMEET_PROFILE_DIR=data/browser-profile`, `ROBO_BACKEND_MODEL=gpt-5.6-sol`, `PULSE_SINK=robomeet_null`; joins; shares; sends context with agent name, cwd, project; voice policy: start on speech, stop after 120 s silence, app cap 10 min) and `bin/attend-stop.mjs`. README section "Global launch" and `TESTPLAN.md` added.
- **Echo root cause and fix**: the robot's Chrome played the call through the laptop speakers; a second Meet session on the same laptop fed it back. Fix: a PulseAudio/PipeWire null sink `robomeet_null` (created on demand by attend.mjs) and `PULSE_SINK=robomeet_null` on the server, so every robot Chrome stream lands on the null sink (verified: all six sink-inputs on that sink). Laptop muting is now opt-in (`--mute-laptop`). Test 1 passed: Vivek joined from the same laptop as Physics Animated (uiowa account was allowed in), spoke with speakers on; robot answered; no feedback reported.
- **Delegation model**: `gpt-5.6-sol` (model id verified in the account's model list; luna/sol/terra all exist). Slide cap raised 30 → 400 in `src/server.mjs` and `src/mcp.mjs` (user-directed).
- **Test 2 passed**: context ("running as a local app on your laptop", "Claude Code"), delegation (robot called ask_coding_agent → job landed in this session via `bin/tool.mjs listen` → verified reply about gpt-live-1 / gpt-5.6-sol → robot spoke it). Notes not exercised by voice tonight.
- **Costs**: closed voice sessions today: 33+46+19 (Codex), 509 (idle), 191, 453, 120 s = 1371 s ≈ 23 min of GPT Live. Backend usage events carry token counts per delegation.

### Gaps found tonight (to build next; all new modular work)
1. The voice model has no tools to turn its own camera or screen share on/off; it told Vivek it could not. Claude toggled both by clicking in the robot's window. Add `set_camera`/`set_share` delegation tools and live camera/share state in context.
2. Google's "Others may see your video differently / Got it" modal blocked the worker's Stop-presenting click (share off failed until the modal was dismissed). The worker should dismiss "Got it" modals like Attendee does.
3. Context should carry the account's Meet display name ("Vivek Bot") and the voice/delegation model names automatically (Claude patched them by hand mid-call).
4. Face: mouth trails the voice (loudness-driven, smoothed, plus Meet video latency); caption reads "Listening" until the first word. Decision pending from Vivek: robot character vs human presenter. Recommended: fix sync in our renderer first (analyze ahead of a ~120 ms audio delay; drive caption from response events), 2D face first, 3D later; external avatar services only if photorealism is required.
5. Claude cut voice off once while Vivek was still speaking ("bye for now" taken as the end); the launcher restarted it on speech. Do not stop voice by hand while a human is mid-sentence.
- Meet ends the call when the robot is alone for a while (inactivity); the launcher exits cleanly (exit 0). Robot profile stays signed in. Zoom untouched.

## 2026-09-14 00:41 EDT (23:41 CDT Iowa City) — Face scrapped; camera-off default; identity rule; presence-based voice; latency investigation

Vivek's decisions (his words, condensed): scrap the animated face ("the robot face is just icing"; the point is that Claude Code / Codex sessions can reliably join, talk, present, take notes); use the uploaded robot image as the assistant account's profile picture; the robot must introduce itself every time exactly as "I'm Vivek Bot, joining this <Google Meet/Zoom> meeting, connected to a <Claude Code/Codex> session named <session name>, via our in-house RoboMeet software"; "as soon as I say hello I want a response" — the startup and in-conversation latency are unacceptable; the slide limit must go.

### Done and verified by Claude Code
- Google account profile photo of vivekkmk.assistant@gmail.com set to the robot image (data/robot-avatar.jpg) from the robot's own signed-in Chrome profile (Personal info → Profile picture → Upload from Device → Next → Save as profile picture); Meet tile shows it when the camera is off.
- Camera off by default: `ROBOMEET_CAMERA=off` handled in `src/meet-worker.mjs` enableInitialInputs (turns the camera OFF after admission); `bin/attend.mjs --camera on|off` (default off). Verified: robot joined with no video, tile = robot avatar.
- "Got it" modal auto-dismiss added to the worker's inspectMeeting (Attendee pattern); share-off then worked first try.
- Participant count: worker now exposes `status.meeting.participants` (from [data-participant-id] elements, fallback aria-label digits). Verified: 1 when alone, 2 when Vivek joined.
- Presence-based voice policy in attend.mjs (`--voice-on presence|speech|join`, default presence): voice starts when a human is present (verified: started 2 s after Vivek joined, before he spoke) and stops 30 s after the robot is alone (verified: 140 s session closed after he left); silence stop now 10 min; session cap raised to 60 min (ROBO_MAX_SESSION_MS=3600000 from the launcher).
- Identity: new server command `voice-prompt` (src/server.mjs) stores text that is appended to the voice model's INSTRUCTIONS at session creation (the renderer's prompt slot was unwired before); attend.mjs builds it from `--display-name`, platform (from the link), `--agent`, `--session-name` (default: project). First test: it answered with the right facts but paraphrased; wording tightened to "say this sentence word for word, then stop". Session name for this Claude Code session: meetingproject.
- Slide cap 30 → 400 (server + MCP schema). Delegation model gpt-5.6-sol.
- Measured: model reply began within 0.0–0.8 s of the transcribed end of every user sentence (8/8 turns), so remaining perceived delay is transport/buffering/turn-detection. Defect seen: after the human joined at 04:36:11 and the session was live at 04:36:14, the first user transcript arrived only at 04:36:22 — Vivek says his first several hellos were not answered. Cause not yet established.
- A latency workflow is running: GPT Live turn-detection docs, stage-by-stage audio-path audit, measured local-path numbers (isolated server on port 4399), and a "single-hop" design (voice session inside the Meet tab, removing the local bridge in both directions).
- Voice usage this session so far: 202 + 140 s. Tests 15/15 after all changes.

## 2026-09-14 01:20 EDT — Latency and identity work finished autonomously; ready for a live test (Claude Code)

Vivek's standing instruction (2026-09-14): do all preparation without him, never auto-launch the robot for a test, and say "everything is ready, let's do a test" only when nothing is left that needs him. Saved as a memory rule.

- Identity root cause: the renderer sent the meeting context as the session prompt and the server preferred it over the stored `voicePrompt`, so the word-for-word rule never reached the model. Fixed in `src/server.mjs` (stored prompt takes precedence) and `src/live.mjs` (identity rule first in the instructions; base text no longer names the robot "Robomeet" when a prompt is given). Verified in the meeting: "who are you?" → "I'm Vivek Bot, joining this Google Meet meeting, connected to a Claude Code session named meetingproject, via our in-house RoboMeet software." (verbatim); session name → "meetingproject".
- Greeting: new server command `announce` (GPT Live's documented speak-first pattern) and MCP tool `say`; `attend.mjs` greets once per voice session when a human is present (`--no-greet` disables). Measured: human admitted → greeting heard 3.5 s.
- Lost hellos: the session did not exist yet (presence detection + creation ≈ 2 s); hellos spoken during creation are now answered, and the greeting tells the human the robot is live.
- Latency, measured with `tools/latency/` (timed TTS tracks; a second device of the robot account joins the meeting as the listener, no human): direct path 0.95–1.5 s, in-meeting 1.5–2.1 s from end of speech to first robot audio. GPT Live has no turn-detection/VAD/eagerness settings at all (docs checked); an "answer immediately" instruction changed nothing. Applied: jitter-buffer targets on all receivers, silent keep-alive sources in every outgoing audio destination (fixes a ~1 s first-reply inflation found by the workflow), 1 s attend polling. Not applied: single-hop (voice session inside the Meet tab), ~0.1–0.2 s more; drafts under `../work/robomeet-test/latency/single-hop/`.
- Tests 15/15. GPT Live usage for tonight's autonomous runs: 264 s over 6 sessions. Robot is out of the meeting; server running with the patched code.
- Correction (same entry): GPT Live usage for the autonomous runs was 285 s over 7 sessions, not 264 s over 6 (the 15 s greeting check was left out of the first count).

## 2026-09-14 02:06 EDT — Live test 1 with Vivek; single-hop voice path integrated and measured; Realtime API compared (Claude Code)

Vivek's words in the meeting (05:33–05:37 UTC): the greeting should be just "hi"; the full identity sentence only when asked who it is, with the agent (Claude Code/Codex) and the session name as parameters. In the terminal afterwards: latency is not acceptable, is it our audio routing or GPT Live, would LiveKit fix it, use the GPT Live docs MCP; what is the voice model vs the delegation model; can the robot join a Meet link someone else created; Telegram is the notification channel, do all groundwork first and ping only when ready.

- Greeting is now `Hi.`; prompt tells the model the agent and session name are launch parameters (it had called them "hard-coded" after a nudge of mine that used that word). Verified in the meeting: hello → short reply; "who are you" → the exact sentence; session name → meetingproject.
- Single-hop voice path integrated from the workflow drafts as NEW files (`src/meet-live.js`, `src/in-page-voice.mjs`, `src/voice-in-page.mjs`, `src/meet-worker-live.mjs`, `bin/start-live.mjs`; original worker untouched); `attend.mjs --voice-path direct|bridge`, default direct; the launcher restarts an idle server on the other path. Fixture 15/15, unit tests 16/16, observer run in a real meeting: end of speech → first robot audio 1.36–1.52 s (bridge path 1.5–2.1 s).
- Realtime API probe (`tools/latency/realtime/`, same track): server VAD 200 ms gives 0.9–1.1 s direct (GPT-Live direct 1.1–1.5), but it ignored the identity rule in all three runs and semantic VAD stalled 5.6 s on "Okay, thanks. Bye." Not adopted; Vivek's call.
- Docs: GPT-Live has no turn-detection settings (OpenAI reference; LiveKit and Pipecat plugin docs agree); OpenAI publishes no latency figures, only how to measure. OpenAI docs MCP registered at user scope (`openai-docs`, https://developers.openai.com/mcp).
- External meetings: the worker's join path clicks "Ask to join" and waits up to 3 min for admission (`awaiting_admission` → `joined` / `admission_denied` / `admission_timeout`); not yet exercised on a meeting organized by another account — needs Vivek to create one. Zoom unimplemented.
- Telegram: MCP acknowledgment sent (id 19249); the MCP then disconnected; fallback via the Bot API verified (getMe) and used for the ready ping.
- GPT Live usage tonight: 305 s (live test) + about 5 min of autonomous runs; Realtime probe 3 × 40 s.

## 2026-09-14 02:13 EDT — Live test 2: robot joined a meeting Vivek organized (Claude Code)

- Vivek's link https://meet.google.com/emi-ndfz-vud: the robot clicked "Ask to join", Vivek admitted it, `joined` within seconds. External-meeting join works.
- Greeting "Hi." heard; hello → "Hi."; "why does it take you so long" answered; "what's your name" / "who are you" → the full identity sentence each time; Vivek then said (verbatim): "can you be a little succinct and just tell me who you are, what's your name without a long thousand word spiel" and ended the call. Voice 68 s.
- Applied in `bin/attend.mjs` for the next launch: name → "Vivek Bot"; who are you → "I'm Vivek Bot, connected to the Claude Code session meetingproject."; the full sentence only when asked what it is connected to or for full details.

## 2026-09-14 02:23 EDT — Prompt rewritten as facts + judgment; voice live from the moment the robot is in the call (Claude Code)

Vivek's words (terminal, after live test 2): my prompts were rigid, hard-coded responses instead of giving the model all the information and trusting its intelligence; "why do I need to say hello ten times"; "have you optimized for latency"; fix, then text on Telegram.

- Root cause of the hellos, from the event log of the 06:10 call: admitted 06:10:47.98, participant count noticed Vivek only at 06:10:57.99, voice requested 06:10:58.66, greeting 06:11:01.9. Fourteen seconds with nothing listening.
- Fix: `--voice-on join` is the default; voice starts when status is `awaiting_admission` or `joined` (server and the in-page controller accept both; the Meet page has the call's audio tracks while knocking; the controller retries quietly until they are live). Stops after 30 s alone; returns on presence or speech.
- Prompt: no scripted lines. Facts (name, RoboMeet on Vivek's laptop, agent + session name as launch parameters, models, tools, camera off) plus: in a meeting so do not interrupt; answer right away from what you know, briefly; introduce yourself in your own words; a hello gets a hello; feel free to express yourself. Greeting is a cue the model phrases itself (`announce` with `exact: false`).
- Verified with the observer harness: voice live 1.4 s before the second participant clicked join; greeting "Hey! good to see you."; every hello answered; "who are you" → "Hi! I'm Vivek Bot. I'm the AI participant in this meeting and I'm here to help with notes, coding tasks, or presenting slides."; session → "connected to the Claude Code session named meeting project"; turns 1.5–1.7 s. Tests 16/16 ×3.

## 2026-09-14 02:34 EDT — Prompt reduced to facts + "be yourself" (Claude Code)

Vivek (terminal): the two input parameters are the coding agent (Claude Code or Codex) and the session name; the model must be told it was launched by RoboMeet and is connected through an MCP server to that session; and "you don't need to tell it what it needs to say... just give it all the information you have and tell it to be itself, nothing else."
- Confirmed in `bin/attend.mjs`: `--agent` and `--session-name` fill the template; nothing hard-coded. My earlier messages had substituted this launch's values, which read as hard-coded.
- Added "connected through the RoboMeet MCP server". Removed every line about how to answer, in `attend.mjs` and in the base instructions of `src/live.mjs` (only the tool mechanics remain after the prompt). Greeting cue is now just "Someone just joined the meeting with you."
- Observer run: greeting "Hey there. I'm here."; hellos → "Hi, I'm here." / "Hey, I'm here with you in the meeting. What do you need?"; who are you → "I'm Vivek Bot, a helper in this meeting, connected to the coding agent for this project."; session → "The session name is meeting project." Voice live before the second participant joined; turns 1.7–1.8 s. Tests 16/16.

## 2026-09-14 03:01 EDT — Live test 3 on Vivek's own meeting: join, greeting, delegation and slides tested; three failures found and fixed; Vivek ended the call over the voice changing (Claude Code)

- Worked: knock → admitted; voice live at join; hello answered at once; identity and "how did you join" answered in the model's own words; a delegated job (one-slide ELI5 diagram of how it works) reached this session and the spoken reply came back.
- Failed and fixed: (1) slide video never reached Meet: the slide canvas only emitted frames when it changed and Meet never got a first frame (Meet-side screenFrames 0); `public/media.js` now repaints the slide canvas every 200 ms; verified frames flowing. (2) The pane could only show text; Vivek called the text slide "bullshit"; `public/media.js` now draws a picture when a slide body is `image:/slides/<file>` served from `public/slides/`; the ELI5 diagram was rendered to `public/slides/how-vivek-bot-works.png` and shown. (3) Rejoining quickly failed twice: Meet showed only "Switch here" (our own stale session); `src/meet-worker-live.mjs` now opens "Other ways to join" and clicks "Join here too", never "Switch here". (4) The voice model stayed silent while my 49 s reply was pending; it is now told it may keep talking during a coding-agent request. (5) The voice sounded different after each rejoin; `src/live.mjs` now pins `audio.output.voice` to marin (`ROBO_VOICE` overrides).
- Vivek's corrections in the call, verbatim gist: no web-page artifact, no moving or switching windows, diagram only in the presentation pane, no more rejoins unless unavoidable and approved; slow down; and finally "your voice is changing, I'm ending this meeting". Each rejoin also lost the conversation (new session) and opened the robot's Chrome window on his laptop.
- Not done: the published web page (https://claude.ai/code/artifact/09483fe8-c537-418e-a9b8-6e18dcd3ee12) is unused; deletion needs Vivek's confirmation. Voice this test: see totals below.

## 2026-09-14 03:06 EDT — Vivek's dictation after live test 3: the first test worked; the cracks that jumping the gun revealed

Dictated by Vivek (transcribed voice, terminal), recorded in his terms:

- The very first test we were actually aiming for — I send a Google Meet link, it joins via the link, and it just has a natural conversation and introduces itself — went extremely well this time. There was pretty low latency, acceptable latency. That's one.
- Second, because of the prompt, which I screamed at you to get correct, look how smooth it was. It felt free, and it responded so nicely, exactly how GPT Live usually responds. I was very happy with that result.
- Everything up to that point: how we got to that stage, and the fact that this test worked.
- Then we jumped the gun, which I shouldn't have, but jumping the gun revealed a lot of cracks:
  1. Why is the voice changing? The voice changed from female to male. I hated that. Have you not hard-coded the voice? That is critically important. Write it down as a critical error, and if it is not hard-coded, it needs to be fixed.
  2. When it said it had to talk to the coding agent (Claude Code) for the presentation, why did it freeze and stop talking to me? It is supposed to delegate to the delegation model, the delegation model talks to Claude Code, and meanwhile it should still be free to talk to me.
  3. The artifact it presented the first time was absolute shit. That is Claude Code's fault: either the ELI5 skill was not invoked or it was done wrong; ELI5 is supposed to give beautiful simple explanations.
  4. Then Claude Code made a nice artifact and asked to delete it. When I am screaming, shouting and angry, pay attention to what is actually angering me and don't do the wrong thing.
- A markdown file with all these edits and observations is to be made, and then anchored as well.

Non-contradicting additions by Claude Code (subordinate to the above):
- How we got there, in order: signed-in dedicated profile with keyring launch flags (admission); null-sink audio routing (no echo); camera off, robot profile picture; presence-based voice, then voice from the moment the robot is in the call (even while knocking), which removed the 10 s dead window after admission; single-hop voice path (GPT Live session inside the Meet tab), jitter targets and keep-alive sources (1.4–1.7 s from last word to first word, measured); the prompt reduced to facts plus "be yourself" with the agent and session name as launch parameters, no scripted lines; a greeting cue the model phrases itself.
- The first test in this call (06:39 UTC): knock → admitted; voice live at join; "Hello" → "Hello! I hear you — looks like it's just us here. How can I help?"; name and who-are-you answered in its own words; how it joined and what software, answered from the facts.
- The voice was not pinned in the session config before this call (no `audio.output.voice` was sent, so each session got whatever default the service chose). It is now pinned in `src/live.mjs` to `marin`, overridable with `ROBO_VOICE`. Which of the three voices heard tonight was `marin` is not known; if the pinned one is not the female voice Vivek wants, the env var changes it.
- The errors file follows in the next entry.

## 2026-09-14 03:07 EDT — Errors and observations file created (Claude Code, per Vivek's dictation)

Vivek asked for a markdown file with all the edits and observations from live test 3, and for it to be anchored. It is `robomeet/errors_and_observations.md`. It records: the test that worked (link → join → natural conversation → introduces itself, acceptable latency, the free prompt) and how we got there; critical error 1, the voice changing between sessions (it was never pinned; now `audio.output.voice: marin` in `src/live.mjs`, `ROBO_VOICE` overrides, not yet verified by ear); error 2, silence while a coding-agent request was open (49 s reply; the model is now told it may keep talking; unverified); error 3, the first ELI5 result was a text list because the pane could only draw text (picture slides added: body `image:/slides/<file>`; slide canvas now redrawn continuously so frames actually reach Meet); error 4, asking to delete the good artifact instead of reading what was actually angering him (artifact kept); plus the "Join here too" rejoin fix, the loss of conversation on rejoin, and the voice seconds used.

## 2026-09-14 03:13 EDT — Vivek's dictation: marin is the right voice; PDFs; launch context; freeze

Dictated by Vivek, recorded in his terms:
- I tested the marin voice in the playground; it is the voice I liked, so pinning it is good.
- It is good that pictures are allowed in the presentation pane; also allow PDFs, that is what we will need. A tremendous amount of testing will be needed.
- The freezing during delegation needs to be fixed as well.
- A tremendously big issue: if it logs in by itself, the launch skill must give it context. Not just "be yourself". Yes, be yourself, but here is all the information you need: whether it is Claude Code or Codex, the session name, that it is GPT Live, that it has a backend model, what the backend model is, its specs, how it works, that it can talk to all of it, that it runs on the RoboMeet software we developed in house, that it assists in meetings, that it is connected to a coding session. And if there is additional context at launch, give it that context. Neither chain it so it cannot be itself, nor leave it out in the wild without context. Give it all the context it needs and let it express itself.

## 2026-09-14 03:20 EDT — Fixes from Vivek's dictation, done and verified (Claude Code)

- Full launch briefing (`bin/attend.mjs` `buildBriefing`): what it is; RoboMeet (in house, on Vivek's laptop) launched it and links it to a coding session; gpt-live-1 (full duplex, own turns); gpt-5.6-sol as the backend reasoning model and how delegation works; the tools; the coding session (agent and session name as launch parameters, MCP server, directory, project, reads the transcript); it can keep talking while a request is pending; camera and screen; why it is here (`--purpose`, default given); extra context (`--brief`); recap of earlier transcript on a rejoin; then "be yourself". Prompt cap raised to 6000 chars. The skill tells every launching session to fill `--purpose` and `--brief`.
- Freeze during delegation: `src/live.mjs` cues the model (commentary) the moment a coding-agent job is queued. Verified with a 25 s held job: hand-off acknowledged, every hello and "are you still there" answered meanwhile, result reported.
- Full-context launch verified in the test meeting: briefing 2320 chars with purpose and brief; greeting "Hey, I'm here."; hellos answered in 1.1–1.4 s; "I'm Vivek Bot, an AI teammate here in this Meet. I can talk, help with questions, take notes, and present things if you ask. I'm connected to the coding session named meetingproject."
- PDFs: `src/pdf-slides.mjs` + `bin/present-pdf.mjs` + MCP tool `present_pdf` (pdftoppm → picture slides); tested on a 3-page PDF.
- Voice pinned to marin, confirmed by Vivek as the voice he liked in the playground.
- `robomeet/errors_and_observations.md` updated with the fixes. Tests 16/16.

## 2026-09-14 03:31 EDT — Stopping for the night; where to pick up (Vivek's instruction)

Vivek: no test now, sleep; tomorrow (or whenever) we test, and we must know where we are starting from and what test to run. Both are written in `robomeet/test_2026-09-14_0330.md`: the starting point (the link → join → natural conversation → introduces itself test works, acceptable latency, free prompt), everything resolved since (voice pinned to marin, freeze during delegation fixed and verified, full launch briefing with `--purpose`/`--brief`, pictures and PDFs on the shared screen, "Join here too" rejoin, single-hop voice path), the next test as seven ordered steps with expectations (greeting, hello, who are you, a note, a coding-agent job, a PDF, bye), the rule for the call (no rejoins, no windows, no published pages; say so and stop), and what stays untested after it. Companion file: `robomeet/errors_and_observations.md`. Robot idle, server idle, tests 16/16.

## 2026-09-14 17:40 CDT — Test 4 completed; tiers.md created

Test 4 (meeting https://meet.google.com/wvx-asjv-mxi) completed. Results:
- Knock/admit: OK
- Greeting: "Hey, I'm here. How's it going, Vivek?"
- Conversation: answered identity, name, backend model, coding agent, hypothetical Codex launch — all correct in own words
- Notes: "can you take notes?" answered; note saved ("Action item: Reach out to Sid over the coming weekend to schedule a meeting for the week of September 21, 2026.")
- LaTeX job: one-page projectile motion PDF compiled and presented
- Voice name question: answered "marin" (delegated to coding agent)
- PDF quality: unreadable on 720px canvas → banding fix (1920×1080 halves) applied mid-call and re-presented
- Screen share: Vivek asked to stop; robot falsely claimed to have stopped it (it cannot); coding agent stopped it
- Confirmation question ("is the coding agent the one putting things on screen?"): delegated to coding agent; session hit context compaction → 6 minute delay (not a bug, session rebuilt context)
- Voice: marin throughout, no voice change

New observations from test 4:
- Robot hallucinated PDF details ("numeric example and diagram") that didn't exist
- Robot falsely claimed to stop screen share — needs standing fact in briefing that it cannot
- Context compaction mid-call causes multi-minute job delays — a session with more headroom wouldn't hit this

Post-test fixes applied to briefing (`bin/attend.mjs buildBriefing`):
1. Voice name: "your voice is marin, hard-coded" now in the briefing
2. Delegation instruction: "If someone asks you something you do not have in your context, delegate it — rather than guessing or saying you do not know"
3. Expression: "Be yourself — express yourself freely, say what you think, and do not hold back"

### tiers.md — capability tier structure (Vivek dictated 2026-09-14)
Three tiers: Attend → Converse → Present. Full breakdown in `robomeet/tiers.md`.
- Tier 1 (Attend): Google Meet works (join link, create link, phone or laptop); Zoom not implemented
- Tier 2 (Converse): mostly working; new briefing items (marin, delegation, expression) untested; latency 1.4–1.5 s; hallucination and false claims are open issues
- Tier 3 (Present): works but quality is poor; canvas is 1280×720, source images 1920×1080 get downscaled; needs canvas upgrade, PPT/HTML support, possibly native screen share

## 2026-09-14 23:04 CDT — Tier 3 (Present) deep dive shipped: resolution, sync, latency

Goal (Vivek, /goal): dive deep into screen sharing (resolution, sync, latency), use /behavioral-test-loop and small
workflows, ship something that really works, notify on Telegram. Evidence: `robomeet/tools/present-lab/runs/final_report.md`,
`robomeet/docs/presentation-spec.md` (results table), `robomeet/errors_and_observations.md`, `robomeet/tiers.md`.

- **Resolution.** The shared screen is a 1920x1080 stage drawn inside the Meet tab and marked as screen content. The
  old path reached participants at 480x270 (SSIM 0.85); the stage at 1920x1080 (SSIM 0.999 offline). Live, another
  participant receives AV1 screenshare (1143x643 for a 1600x900 window): SSIM 0.976 for the PDF, 0.9988 for a slide.
- **Formats.** `present_file`: PDF, .pptx/.ppt/.odp, .docx/.doc/.odt/.rtf, .html or a URL, pictures. Slides whole,
  documents and pages as screen-sized reading windows with pixel-exact renders.
- **Sync.** Narrated walk (`narrate`): the screen moves about 0.9 s before each part is spoken; a real question pauses
  it; "Okay, continue" resumes it; a part the robot already covered is not repeated; "next" mid-part stops the robot
  talking (0.8 s) and moves the screen (0.4-0.5 s).
- **Latency.** A screen move reaches others in 342-528 ms. Not met live: the gap between parts is about 2.8-3 s
  (1.8 s offline), set by GPT Live's own response time.
- **Testing.** 8 iterations (4 live with voice, each recorded), 2 adversarial review workflows (28 agents) plus a fix
  agent: about 60 defects found and fixed. 126 of 126 tests pass. Live runs found two things no offline test did:
  exact-word coverage undercounts paraphrase, and input transcription can invent words in a silent room.
- Nothing committed or pushed. The server runs idle with no deck. Next with Vivek: a live test of presenting,
  when he says so.
