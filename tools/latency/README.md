# Latency harness (no human needed)

Measures the voice path with a timed microphone track (OpenAI TTS clips at known offsets), so every
stage is timestamped on one clock: microphone onset/offset, session setup, transcript deltas, and the
first robot audio. Two modes:

- `run-preview.mjs` — direct path: a fresh Chrome plays `track.wav` as its microphone into a
  preview-mode GPT Live session (no meeting, no bridge). Env: `TRACK=silence ANNOUNCE="..."` tests the
  speak-first announcement; `RUN_SECONDS` caps the run.
- `run-observer.mjs` — full in-meeting path: launches the robot with `bin/attend.mjs`, then joins the
  same meeting as a second device of the robot account ("Other ways to join" → "Join here too") whose
  microphone is `observer-track.wav`, and records what that participant hears. Env: `MEET_URL`,
  `ATTEND_ARGS` (default `--no-share`), `OBSERVER_PROFILE` (default `data/observer-profile`, copied
  from `data/browser-profile` on first use).

Steps (from the app root, server running):

```bash
node tools/latency/make-clips.mjs            # once: clips/*.wav via OpenAI TTS
python3 tools/latency/build-track.py         # track.wav + track.json
python3 tools/latency/build-observer-track.py
node tools/latency/run-preview.mjs && python3 tools/latency/analyze.py
node tools/latency/run-observer.mjs && python3 tools/latency/analyze-observer.py
```

Both runs bill GPT Live for their duration (about 40 s and 60 s). Reference results from 2026-09-14
are in `runs/`. Robot audio never reaches the laptop speakers: both Chromes run with
`PULSE_SINK=robomeet_null`.

Also here:

- `realtime/run-realtime.mjs` + `realtime/analyze-realtime.py` — the same track against the Realtime API
  (`gpt-realtime`) with `VAD=server SILENCE_MS=…` or `VAD=semantic EAGERNESS=…`, for a like-for-like
  comparison with GPT-Live. Results in `runs/realtime/`.
- `single-hop-fixture.mjs` — headless Chrome fixture for `src/meet-live.js` layered over `src/meet-media.js`
  (no server, no OpenAI): routing, gates, close order. 15 checks.
- `ATTEND_ARGS="--no-share --voice-path bridge" node run-observer.mjs` measures the original renderer path.
