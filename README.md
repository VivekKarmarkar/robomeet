# RoboMeet

A local meeting robot with an animated camera, a separate slide presentation, GPT Live voice, meeting notes, and an MCP connection to your coding agent. Built as a new standalone app; the original Professor Claude / LiveKit project is unchanged.

## Run

From this directory:

```bash
npm ci
npm start
```

Open **http://127.0.0.1:4318**. Paste a Google Meet link and join. The host may need to admit the AI participant. Start voice explicitly after admission, then select **Speak** when it should be able to answer. The default **Listen** mode hears the meeting while muting outgoing speech.

**Stop** closes the paid voice connection. **Leave** also closes the meeting browser. Muting is not the same as stopping: an active muted model session can still incur API charges. A voice session defaults to a ten-minute maximum, and a lost renderer heartbeat triggers shutdown. `Ctrl+C` shuts down the server and its owned browser.

The robot uses its own Chrome instance and synthetic media tracks. It does not capture your laptop microphone or camera in meeting mode. The separate **local voice preview** uses your microphone only after you start it.

### Google sign-in when guest admission is rejected

If Google rejects an unsigned-in participant, give the robot a legitimate login in its own profile:

```bash
node bin/login.mjs
```

Sign in as `vivekkmk.assistant@gmail.com` in that separate Chrome window, then close it. Start the app with:

```bash
ROBOMEET_PROFILE_DIR=data/browser-profile npm start
```

The profile remains inside this app's `data/` directory. The app refuses existing unrelated profiles, symlinks, and profiles already open in another Chrome process. There is no cookie copying or automated login bypass. A signed-in bot's displayed Meet name comes from its Google account; the camera explicitly identifies it as an AI participant.

## Terminal controls

```bash
node bin/command.mjs join 'https://meet.google.com/abc-defg-hij'
node bin/command.mjs context 'Discuss the project roadmap. Speak only when addressed.'
node bin/command.mjs start-voice
node bin/command.mjs mode speak
node bin/command.mjs present example-slides.json
node bin/command.mjs share on
node bin/command.mjs stop-voice
node bin/command.mjs leave
```

Other commands: `status`, `listen CURSOR TIMEOUT_MS`, `note TEXT`, and `reply JOB_ID RESULT`. Decks can be JSON, text, or Markdown through the dashboard; the terminal `present` command accepts JSON. Use `---` between text slides. PDF rendering is not included in this version.

## Connect a coding agent

The standard stdio MCP entry point is `bin/mcp.mjs`; run it with Node using an absolute path. It connects to the already-running local app. No OpenAI key goes through MCP.

Tools: `status`, `join`, `leave`, `voice`, `mode`, `listen`, `reply`, `send_context`, `present`, `slide`, and `notes`.

For an existing coding task that cannot add an MCP server while it is running, the included terminal client uses the same real MCP protocol:

```bash
node bin/tool.mjs tools
node bin/tool.mjs listen '{"after":0,"timeoutMs":50000}'
node bin/tool.mjs reply '{"jobId":"ID_FROM_LISTEN","result":"The completed result"}'
node bin/tool.mjs present '{"title":"Update","slides":[{"title":"Progress","body":"The change is ready for review."}],"enabled":true}'
```

Keep the returned cursor and supply it to the next `listen` call. A request includes a stable job ID and reference context. The coding agent completes the work in its existing repository/task, then replies with that exact ID. The app feeds the result back to the original voice session. Repeated identical replies are safe; conflicting duplicate results are rejected.

By default, MCP `listen` waits for actionable events, including coding requests and saved notes. Continuous transcript chunks and media telemetry do not keep waking the coding agent. Supply `types:["transcript"]` when transcript events are specifically needed.

**An MCP server does not wake an idle Codex desktop task by itself.** While attending, the coding task must actively call `listen` and handle requests. This app does not create a separate Codex task, alter the desktop harness, or install a background polling automation. The included terminal client lets the current task participate without editing working global configuration.

## Configuration

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Server-side OpenAI API key. |
| `ROBO_OPENAI_ENV` | Alternative existing env file containing the key. |
| `ROBO_BACKEND_MODEL` | Responses delegation model; defaults to `gpt-5.6-luna`. |
| `ROBO_PORT` | Local HTTP port; default 4318. |
| `ROBO_URL` | Local URL used by the terminal and MCP clients. |
| `ROBO_DATA_DIR` | Local notes, events, jobs, and control token directory. |
| `ROBO_MAX_SESSION_MS` | Maximum voice duration; default 600000 ms. |
| `ROBOMEET_CHROME_PATH` | Chrome executable; default `/usr/bin/google-chrome`. |
| `ROBOMEET_DISPLAY` | Linux display override. |
| `ROBOMEET_HEADLESS` | Set to `1` for headless execution where supported. |
| `ROBOMEET_PROFILE_DIR` | Opt into the dedicated app profile, e.g. `data/browser-profile`, after normal sign-in. |

On this machine, the server can read the already-existing key from the original LiveKit project's `agent-py/.env.local`. It never rewrites that file, sends the key to the browser, or embeds it in the deliverable. Other machines should supply `OPENAI_API_KEY` or `ROBO_OPENAI_ENV`.

The app binds to loopback and uses a local control token with restrictive file permissions. Cross-origin requests are rejected. Notes, transcripts, and job results are stored locally in `data/state.json`. Do not publish this data directory.

## Components

```text
Google Meet web client ⇄ isolated browser media adapter
                               ⇅ browser media tracks
                      robot + slides renderer ⇄ GPT Live
                               ⇅ local app state     ⇅ delegation
                               Node server ⇄ Responses tools
                                    ⇅
                            MCP listen / reply
                                    ⇅
                       your existing coding agent task
```

`src/meet-worker.mjs` handles meeting admission and browser lifecycle. `src/meet-media.js` routes meeting media; it keeps the bridge's own generated audio out of the incoming mix. `public/media.js` renders the face and slides and applies hard audio gates. `src/live.mjs` owns GPT Live and its server control connection. `src/store.mjs` persists notes and correlated jobs. `src/mcp.mjs` exposes agent controls.

There is no LiveKit, Recall, hosted relay, ngrok tunnel, external frontend CDN, or serialized speech-recognition/TTS pipeline in this app. The development test fixtures use local synthetic speech solely to verify audio routing.

## Validation and scope

Run `npm test`. Tests exercise browser media routing, separate video tracks, echo exclusion, replacement meeting tracks, session cancellation and cleanup, durable job correlation, origin checks, and an actual MCP subprocess connection. These tests use fixtures and make no paid model calls.

Actual provider and meeting results are recorded in `VALIDATION.md`. Google Meet web-client admission and media behavior can change independently of this app. Zoom is a separate future adapter and is not implemented here.

## Global launch (Claude Code and Codex)

Everything above still applies. This section covers the pieces that make the robot reachable from any Claude Code or Codex session on this machine: one global MCP registration per agent, two skills, two launch scripts, and the operating rules they enforce.

### User-scope MCP registration

The MCP server is registered once, at user scope, for both agents. It connects to the already-running local app on `http://127.0.0.1:4318` and authorizes with `data/control-token`; it does not start the server.

Claude Code (user scope, available in every project):

```bash
claude mcp add --scope user robomeet -- node /home/vivekkarmarkar/Documents/Codex/2026-09-11/okay-so-i-have-an-interesting/outputs/robomeet/bin/mcp.mjs
claude mcp get robomeet          # verify: Scope: User config, Status: Connected
claude mcp remove robomeet -s user   # undo
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.robomeet]
command = "node"
args = ["/home/vivekkarmarkar/Documents/Codex/2026-09-11/okay-so-i-have-an-interesting/outputs/robomeet/bin/mcp.mjs"]
```

Both entries run the same `bin/mcp.mjs` by absolute path. Never register this server project-scoped (`.mcp.json`). A session that cannot attach the server mid-turn still has `node bin/tool.mjs <tool> '<json>'`, which speaks the same MCP protocol over a subprocess.

### Skills: `/robomeet` and `/robomeet-stop`

Two skills wrap the launch scripts so a session can attend a meeting with one command.

| Skill | Does | Claude Code | Codex |
| --- | --- | --- | --- |
| `/robomeet [meet-url] [flags]` | With no URL, creates a fresh OPEN Meet space for the assistant account and tells you the link. Runs `bin/attend.mjs` in the background with `--agent`, `--cwd`, `--project`, and `--json` (extra flags pass through), waits up to two minutes for its `joined` line, then turns the calling session into the robot's coding agent: long-polls `listen`, does each delegated job in that session, answers with `reply`, and sends requested decks through `present`. Ends on `/robomeet-stop`, a terminal `meeting.status`, or the user saying stop. | `~/.claude/skills/robomeet/SKILL.md` | `~/.codex/skills/robomeet/SKILL.md` |
| `/robomeet-stop` | Runs `bin/attend-stop.mjs`, then reads `node bin/command.mjs status` and reports `meeting.status` (expected `ended`), `voice.status` (must be `idle`, otherwise it does not report the robot as stopped), and `voice.usage.seconds`. Ends the attend loop if one is running. | `~/.claude/skills/robomeet-stop/SKILL.md` | `~/.codex/skills/robomeet-stop/SKILL.md` |

Both files use the house `SKILL.md` format (YAML frontmatter with `name` and `description`, then the workflow), the same shape as `~/.claude/skills/time/SKILL.md`. Codex reads the identical file from its own skills directory.

### `bin/attend.mjs` and `bin/attend-stop.mjs`

```bash
node bin/attend.mjs <meet-url> [--name NAME] [--agent AGENT] [--cwd DIR] [--project NAME] [--session-id ID] [--session-name NAME] [--display-name NAME] [--no-share] [--no-voice-auto] [--voice-on presence|speech|join] [--camera on|off] [--mute-laptop] [--silence-ms MS] [--no-greet] [--voice-path direct|bridge] [--purpose TEXT] [--brief TEXT] [--json]
node bin/attend-stop.mjs
node bin/present-pdf.mjs <file.pdf> [--title TITLE] [--max-pages N] [--no-share]
```

| Flag | Meaning |
| --- | --- |
| `--name` | Display name requested at join (a signed-in robot still shows its Google account name; see the sign-in section above). |
| `--agent`, `--cwd`, `--project`, `--session-id` | Identify the coding session the robot is attending for: the agent name (`"Claude Code"` or `Codex`, as the skill passes it), the session's working directory, its project name (the skill uses the directory basename), and a session ID. They go into the meeting context so the voice model knows which agent, repository, and session receive delegated work. |
| `--session-name`, `--display-name` | The coding session's name and the robot's participant name. They fill the fixed self-introduction the voice model is instructed to use: "I'm <display name>, joining this <Google Meet or Zoom> meeting, connected to a <agent> session named <session name>, via our in-house RoboMeet software." That text is sent with the `voice-prompt` command and becomes part of the model's instructions for every session. |
| `--voice-on` | `presence` (default): start voice as soon as a human participant is in the call (`status.meeting.participants` > 1) and stop 30 s after the robot is alone; `speech`: start on first detected speech (old behaviour, costs the first sentence); `join`: start immediately at join. |
| `--camera` | `off` (default): join without video, the account's profile picture shows; `on`: send the animated face. |
| `--no-share` | Join without requesting the browser screenshare of the presentation. |
| `--no-voice-auto` | Do not start voice automatically on speech; start it yourself with `node bin/command.mjs start-voice`. |
| `--mute-laptop` | Also mute the laptop's default output while attending. Not needed normally: the robot's audio is routed to a null sink (see Echo below). Never use it when you join from the same laptop. |
| `--silence-ms` | Override the silence window after which voice is stopped (default 600000, ten minutes; presence normally decides). |
| `--no-greet` | Do not have the robot speak first when a human is present. By default it says `Hi.` once per voice session as soon as a human is in the call, so hearing it means the robot is live. The full identity sentence is reserved for identity questions. |
| `--purpose` | Why this session is sending the robot and what it is working on. Goes into the briefing verbatim. |
| `--brief` | Any extra context the launching session has for this meeting (agenda, people, project state, what may be presented). Goes into the briefing verbatim. |
| `--voice-path` | `direct` (default): the GPT Live WebRTC session runs inside the Meet tab (`src/meet-live.js`, worker `src/meet-worker-live.mjs`, launcher `bin/start-live.mjs`). `bridge`: the original renderer path. The launcher restarts an idle server that runs the other path. |
| `--json` | Machine-readable output for scripts and agents. |

Both scripts talk to the app on `http://127.0.0.1:4318` with the bearer token from `data/control-token`, exactly like `bin/command.mjs`. The launch the global path relies on is the signed-in one with the delegation model pinned:

```bash
ROBOMEET_PROFILE_DIR=data/browser-profile ROBO_BACKEND_MODEL=gpt-5.6-sol npm start
```

`attend.mjs` creates the null audio sink if needed, starts the server with the robot's audio routed to it, joins, waits for admission, requests the screenshare, and runs the voice policy below, printing `joined` once the robot is in the call (`--json` makes every line machine-readable). `attend-stop.mjs` is the mirror: `stop-voice`, `leave`, unmute. The listen/reply loop is in neither script; the `/robomeet` skill (or you) runs it. Create a fresh open Meet space for the assistant account with:

```bash
GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$PWD/data/gws-meet-auth" gws meet spaces create --json '{"config":{"accessType":"OPEN","entryPointAccess":"ALL"}}'
```

The returned `meetingUri` is the URL to pass. The robot is the organizer of spaces created this way, so it needs no admission there; on someone else's meeting the host still admits it.

### Voice policy

Voice is the paid part, so `attend.mjs` runs it only while there is someone to talk to:

- **From the moment it is in the call (default, `--voice-on join`).** Voice starts as soon as the meeting status is `awaiting_admission` or `joined`: the Meet page already receives the call's audio while it knocks, so the session is live before the host finishes admitting the robot and before anyone says hello. (The earlier presence trigger waited for the participant count, which took 10 s to notice the host in the 2026-09-14 live test.) After 30 s alone the session stops; it comes back when a human is counted or speaks. `--voice-on presence` waits for a counted human; `--voice-on speech` waits for audible input.
- **Greeting.** Once per session, when voice is active and someone is there (a counted human, or admission by a host before the count is known), the robot is cued to greet in its own words (`announce` with `exact: false`, a `session.commentary.append`). `--no-greet` disables it; `ROBOMEET_GREETING` changes the cue.
- **Stop when alone or silent.** Voice stops 30 s after the robot is the only participant, or after 10 minutes without audible input or robot speech (`--silence-ms`). `--no-voice-auto` disables the whole policy.
- **60-minute cap per session.** The launcher sets `ROBO_MAX_SESSION_MS=3600000`; the live manager closes the session with reason `duration_limit` when it is reached. `status.voice.maxDurationMs` shows the cap in force.

Mode is independent of this policy: use `node bin/command.mjs mode speak` when the robot should answer, `listen` when it should only hear, `quiet` to mute both directions. Muting is not stopping; only `stop-voice` (or the policy, cap, or leave) ends billing.

### What the voice model is told

A full briefing, then "be yourself" (Vivek's rule, 2026-09-14: give it all the context it needs and let it express itself; neither strangle it with scripts nor send it in without context). `attend.mjs` builds it (`buildBriefing`), stores it with the `voice-prompt` command (up to 6000 characters, placed at the top of the session instructions) and also sends it as the meeting context for the backend model. It covers: its name; that RoboMeet, our in-house software on Vivek's laptop, launched it, carries its audio and links it to a coding session; its voice model gpt-live-1 (full duplex, decides its own turns); its backend reasoning model gpt-5.6-sol and how delegation works (receives the conversation, thinks, picks a tool, hands back text); the tools `take_note`, `present_slides` (text or picture slides) and `ask_coding_agent`; the coding session (`--agent` and `--session-name`, both launch parameters, connected through the RoboMeet MCP server, its directory and project, what it can do, that it reads the live transcript); that it can keep talking while a coding-agent request is in progress; camera and screen state; why it is here (`--purpose`, or a default); extra context from the launching session (`--brief`); on a rejoin of the same meeting, a recap of what was said before (from the transcript events); who is speaking. Then: you are in a meeting, so do not disturb it unnecessarily; when someone asks you something, respond immediately with what you know; be yourself.

The moment a coding-agent request is queued, the server also cues the model (`session.commentary.append`) that the request is with the coding agent and it can keep the conversation going. Verified 2026-09-14 with a job held for 25 s: it said it had handed the request over, answered every hello and "are you still there" meanwhile, then reported the result.

Any session can make the robot say something now: MCP tool `say` (`{"text": "..."}`) or the `announce` command (`exact: false` for a cue it phrases itself). It needs an active voice session.

### Pictures and PDFs on the shared screen

A slide whose body is `image:/slides/<file>.png` is drawn full-frame on the slide canvas (files under `public/slides/`, served by the app). PDFs: MCP tool `present_pdf` `{"path": "/abs/file.pdf", "enabled": true}` or `node bin/present-pdf.mjs /abs/file.pdf` renders every page with `pdftoppm` into `public/slides/<slug>/` and presents them as picture slides. The slide canvas is redrawn continuously (a canvas capture stream only emits frames when the canvas changes; before 2026-09-14 Meet never received a first frame). The session voice is pinned to `marin` (`ROBO_VOICE` overrides), the voice Vivek chose in the playground.

### Latency (measured 2026-09-14, `tools/latency/`)

All numbers are end of the speaker's last word to the first robot audio, from timed test tracks with no human involved (`tools/latency/README.md`). Same track, same page hooks, so rows are comparable.

| Path | Seconds |
| --- | --- |
| GPT-Live, direct (page to OpenAI, no meeting) | 1.1 to 1.5 |
| GPT-Live, in the meeting, bridge path (renderer owns the session) | 1.5 to 2.1 |
| GPT-Live, in the meeting, direct path (session inside the Meet tab, now the default) | 1.36 to 1.52 |
| Realtime API `gpt-realtime`, direct, server VAD 500 ms (default) | 1.1 to 1.3 |
| Realtime API `gpt-realtime`, direct, server VAD 200 ms | 0.9 to 1.1 |
| Realtime API `gpt-realtime`, direct, semantic VAD eagerness high | 1.1 to 1.8 (one turn 5.6) |
| Human admitted to greeting heard | 3.2 to 3.5 |

Where the time goes with GPT-Live in a meeting: the model's own end-of-turn decision plus first token, about 0.7 to 1.1 s (`gpt-live-1` has no turn-detection, VAD, silence or eagerness settings; turn-taking is model-controlled, confirmed in OpenAI's reference and by LiveKit's and Pipecat's plugin docs; an "answer immediately" instruction measured no change); Google Meet's two legs, about 0.3 to 0.5 s; the app's own path, now about 0.1 s after removing the local bridge from the audio leg. LiveKit does not change any of this: its GPT-Live plugin runs the same model with the same server-driven turns, and LiveKit is not a way into a Google Meet call, where the robot has to be a browser participant exactly as here.

The Realtime API is the one model-side lever: with server VAD at 200 ms it answers about 0.3 s sooner than GPT-Live, at the cost of the delegation architecture (one model does speech, reasoning and tools) and weaker instruction following in the same test (it did not recite the identity sentence when asked who it was, in three runs out of three). Not adopted; the probe is `tools/latency/realtime/`.

Changes made for latency: the session runs inside the Meet tab (single hop), jitter-buffer targets on every audio receiver, a silent keep-alive source in every outgoing audio destination (a destination with no input sends no packets and the far side's buffer inflated by about 1 s until the first replies had flowed), and 1 s polling in `attend.mjs`.

### One-time sign-in

The robot's Google identity lives in a dedicated Chrome profile inside this app's `data/` directory, and it persists across restarts. Do this once:

```bash
node bin/login.mjs
```

This opens normal Chrome with `--user-data-dir=data/browser-profile`, pre-filled for `vivekkmk.assistant@gmail.com`. Sign in, then close that Chrome window. Afterwards every launch that sets `ROBOMEET_PROFILE_DIR=data/browser-profile` (the signed-in launch line above) uses the same profile and joins already signed in. There is no cookie copying; the app refuses profiles outside `data/`, symlinks, directories it did not create, and profiles still open in another Chrome (a `SingletonLock` present means close that window first).

Why the worker launches this profile differently: Chrome signed in through the normal browser encrypts its cookies with the OS keyring. Playwright's defaults `--password-store=basic` and `--use-mock-keychain` cannot decrypt them, so Meet would see the profile as signed out. For the dedicated profile only, `src/meet-worker.mjs` removes those two switches (and `--enable-automation`) from Playwright's default arguments, and the same profile then loads signed in. Verified 2026-09-13.

### Echo: the robot's audio never touches the laptop speakers

The robot's Meet tab would otherwise play the call through the laptop speakers, and a human in the same room, or in a second Meet session on the same laptop, would feed that back into the meeting as echo (the "boom boom" feedback heard on 2026-09-13). The robot does not need the speakers at all: it hears the call through WebRTC tracks and speaks through its own outgoing track. So `attend.mjs` routes all of the robot's audio to a null sink:

```bash
pactl load-module module-null-sink sink_name=robomeet_null sink_properties=device.description=RoboMeet-Null   # attend.mjs does this if the sink is missing
PULSE_SINK=robomeet_null ROBOMEET_PROFILE_DIR=data/browser-profile ROBO_BACKEND_MODEL=gpt-5.6-sol npm start  # what attend.mjs spawns
pactl list sink-inputs | grep -E 'Sink:|application.name'   # robot Chrome streams should show the robomeet_null sink index
```

PulseAudio and PipeWire honour `PULSE_SINK` per process, so the setting reaches the Chrome that the server launches. Verified 2026-09-13 with a test stream. The null sink is created per login session; `attend.mjs` recreates it when needed. If the server was started without `PULSE_SINK`, restart it (or run `attend.mjs` after stopping it) so the routing applies. You can join from the same laptop with your own account and speakers on; only pass `--mute-laptop` if you specifically want the laptop silent. `attend-stop.mjs` unmutes the default output in case a previous run muted it.

### Cost monitoring

Every voice session is paid, so its duration is visible in two places:

- **Live:** `status.voice.usage.seconds` (from `node bin/command.mjs status` or the MCP `status` tool) is the provider's running usage for the current session, updated from GPT Live `session.usage.updated` telemetry. `status.voice.startedAt` and `status.voice.maxDurationMs` sit beside it.
- **Durable:** every `voice.closed` event in `data/state.json` carries `data.usage` (the provider's final usage for that session, or `null` when it reported none), `data.reason` (`requested`, `duration_limit`, `meeting_ended`, `renderer_error`, ...), and `data.sessionId`. `voice.backend_usage` events carry the token usage of each delegation call to the backend model.

To pull the closures for a run:

```bash
node bin/tool.mjs listen '{"after":0,"timeoutMs":0,"types":["voice.closed","voice.backend_usage"]}'
```

`voice.closed` is in the MCP `listen` default type set, so an attending session sees each closure as it happens. Sum `data.usage` across the `voice.closed` events of a meeting for that meeting's spend.
