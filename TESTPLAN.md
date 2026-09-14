# RoboMeet test plan: five spoken tests

Five live tests of the globally launched robot. Each is short because voice is paid and capped at ten minutes per session; the whole plan fits in one or two sessions. Record the observations in the results table at the end.

## Setup

1. Create a fresh Meet space for the assistant account (the robot is its organizer, so no admission wait):

   ```bash
   cd /home/vivekkarmarkar/Documents/Codex/2026-09-11/okay-so-i-have-an-interesting/outputs/robomeet
   GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$PWD/data/gws-meet-auth" gws meet spaces create --json '{"config":{"accessType":"OPEN","entryPointAccess":"ALL"}}'
   ```

   Keep the `meetingUri`.
2. From a Claude Code or Codex session (session A), attend:

   ```text
   /robomeet <meetingUri>
   ```

   With no URL, `/robomeet` creates the space itself and tells you the link. What the skill runs underneath: `node bin/attend.mjs '<meetingUri>' --agent "Claude Code" --cwd "<session directory>" --project "<its basename>" --json` in the background, then the `listen`/`reply` loop.
3. Join the same meeting as a human. Test 1 is deliberately from the SAME laptop (regular Chrome, your own Google account, speakers on, no headphones): the robot's audio is routed to a null sink, so there must be no echo. A phone or second device is fine for the other tests.
4. Confirm the baseline before speaking:

   ```bash
   node bin/command.mjs status
   pactl get-sink-mute @DEFAULT_SINK@
   ```

   Expected: `meeting.status` is `joined`; `meeting.media.input` is `silent` or `active` (not `no-input`); `voice.desired` is `stopped` until someone speaks; `Mute: no` (the laptop speakers stay on; `pactl list sink-inputs` shows the robot's Chrome streams on the `robomeet_null` sink).
5. Speak once ("Robo, can you hear me?") and confirm the voice policy kicks in: `voice.desired` becomes `started`, `voice.status` goes `connecting` then `active`, and a `voice.created` event appears whose `data.backendModel` is `gpt-5.6-sol` (the delegation model in force). Put the robot in `speak` mode if it is not already: `node bin/command.mjs mode speak`.

Event watching during the tests, from any terminal (keep and reuse the returned cursor):

```bash
node bin/command.mjs listen 0 50000
node bin/tool.mjs listen '{"after":0,"timeoutMs":50000}'
```

`listen` returns `{events, cursor, jobs}`. Session A's attend loop is the only place that answers jobs; other sessions may read events but must not `reply`.

## Test 1: context

**Action.** Give the robot a reference fact it cannot know otherwise, then ask for it aloud.

```bash
node bin/command.mjs context 'Project RoboMeet. The release codeword is tangerine. Speak only when addressed.'
```

Say: "Robo, what is the release codeword?"

**Expected.**

- A `context.updated` event with the text, and `status.context` equal to it.
- The robot answers "tangerine" (or a sentence containing it) without delegating: no `agent.request` event and no `voice.tool_requested` event for this exchange.
- Context is appended quietly to the existing voice session: `status.voice.sessionId` does not change and no new `voice.created` event appears.

## Test 2: note

**Action.** Say: "Robo, take a note: ship the README by Friday."

**Expected.**

- A `voice.tool_requested` event with `name: "take_note"`, then a `note.added` event whose `data.text` contains "ship the README by Friday".
- `node bin/command.mjs status` lists the note under `notes` with that text, and the MCP `notes` tool returns it.
- The robot confirms only after the tool result (it must not say "noted" before `note.added` exists). If it acknowledges but no `note.added` event appears, the test fails.

## Test 3: delegation count

**Action.** Say: "Robo, ask the coding agent how many files are in the src directory."

**Expected.**

- A `voice.tool_requested` event with `name: "ask_coding_agent"`, then an `agent.request` event whose `data` is the job: `id`, `request` (the spoken task), `status: "pending"`, `meetingUrl`, and the current `context`.
- Session A's `listen` returns the job in `jobs`. Session A counts the files (the repository's `src/` has nine: `bridge-link.mjs`, `browser-profile.mjs`, `live.mjs`, `mcp.mjs`, `meet-bridge-worker.mjs`, `meet-media.js`, `meet-worker.mjs`, `server.mjs`, `store.mjs`) and replies with the exact job ID:

  ```bash
  node bin/tool.mjs reply '{"jobId":"<id from agent.request>","result":"src contains 9 files."}'
  ```

- An `agent.result` event with `status: "completed"` and the result text; the robot speaks the number nine.
- While the reply is pending the robot may say it is asking the coding agent, but it must not invent a count. A second identical `reply` is accepted; a conflicting one is rejected with HTTP 409.

## Test 4: eight-slide presentation from a second session

**Action.** Open a second Claude Code or Codex session (session B) anywhere on the machine; the user-scope MCP registration makes `robomeet` available there. Call the MCP `present` tool with eight slides and the screenshare enabled:

```json
{"title":"RoboMeet eight-slide check","enabled":true,"slides":[
 {"title":"1 of 8","body":"Presented from a second session over MCP."},
 {"title":"2 of 8","body":"The robot renders these slides itself."},
 {"title":"3 of 8","body":"Meet sees them through the browser screenshare."},
 {"title":"4 of 8","body":"Slide changes come from the slide tool."},
 {"title":"5 of 8","body":"Voice stays on its own session."},
 {"title":"6 of 8","body":"Notes and jobs are unaffected."},
 {"title":"7 of 8","body":"Nearly done."},
 {"title":"8 of 8","body":"End of deck."}
]}
```

Terminal equivalent from session B: `node bin/tool.mjs present '<that json>'`. Then step through with the `slide` tool (`{"index":4}`, then `{"index":7}`).

Say, from the phone: "Robo, we can see your slides now."

**Expected.**

- `status.slides` has length 8, `status.title` is "RoboMeet eight-slide check", `status.slideIndex` starts at 0; a `presentation.share` event with `enabled: true` appears, and `status.meeting.sharing` becomes `true`.
- In Meet, the human sees the robot's shared screen showing "1 of 8"; after the `slide` calls it shows "5 of 8" then "8 of 8", with matching `presentation.slide` events (`index` 4 and 7).
- `{"index":8}` is rejected as out of range; a deck of more than 30 slides is rejected by the tool schema.
- The voice session continues unchanged (same `status.voice.sessionId` before and after); the spoken remark is acknowledged briefly and produces no tool call.
- Session B never calls `reply`; session A's listen loop is undisturbed.

## Test 5: stop

**Action.** From session A:

```text
/robomeet-stop
```

Equivalent: `node bin/attend-stop.mjs`.

**Expected.**

- A `voice.closing` then a `voice.closed` event. `voice.closed` carries `data.reason` (`requested`, or `meeting_ended` if the leave won the race), `data.sessionId`, and `data.usage` (the provider's final usage, or `null` when it reported none). The last `status.voice.usage.seconds` read before the stop is the live figure for the same session.
- `status.voice` is `{desired: "stopped", status: "idle", ...}`.
- `meeting.status` passes through `leaving` to `ended`; the robot disappears from the Meet participant list; no Chrome window for the robot remains.
- `pactl get-sink-mute @DEFAULT_SINK@` prints `Mute: no`.
- `/robomeet-stop` reports `meeting.status`, `voice.status`, and `voice.usage.seconds` from `node bin/command.mjs status`, and session A's listen loop has exited. The profile stays signed in for the next `/robomeet`.

## Results

| Test | Passed | Observed events | Notes |
| --- | --- | --- | --- |
| 1 context | | | |
| 2 note | | | |
| 3 delegation count | | | |
| 4 eight slides | | | |
| 5 stop | | | |

Spend for the run: sum `data.usage` across the `voice.closed` events above (`node bin/tool.mjs listen '{"after":0,"timeoutMs":0,"types":["voice.closed"]}'`).

## Autonomous results, 2026-09-14 (no human in the meeting)

Run with `tools/latency/run-observer.mjs`: the robot joins its own space, a second device of the robot account joins with a timed test track as its microphone, and the harness records what that participant hears. Seven GPT Live sessions, 285 s total.

| Check | Result |
| --- | --- |
| Voice live before the human arrives | Yes: session starts when the robot is in the call (measured live 1.4 s before the second participant clicked join) |
| Human admitted to greeting heard | 0.7 s cue, greeting in the model's own words |
| First hello after joining | Answered at once |
| End of speech to first robot audio, direct voice path (default since 2026-09-14) | 1.36 to 1.52 s (bridge path: 1.5 to 2.1 s) |
| "Who are you?" | Verbatim identity sentence, 1.6 to 1.8 s to first audio |
| "What is the name of the session you are connected to?" | `meetingproject`, 1.5 to 1.8 s |
| Hello spoken while the session was still being created | Answered (1.85 s) |
| First reply vs later replies | No first-reply penalty after the keep-alive fix |
| Second device of the same account | Joins via "Other ways to join" then "Join here too"; must leave cleanly or its ghost blocks the robot's next join for about a minute |

Still to run with Vivek: tests 1 to 5 above, a real delegated job, a long deck from a second session, a meeting the robot did not organize, Codex launch, Zoom.

| Coding-agent request held 25 s while hellos are spoken (preview harness, `tools/latency/delegation.wav` + `job-replier.mjs`) | Robot acknowledges the hand-off, answers every hello meanwhile, reports the result |
