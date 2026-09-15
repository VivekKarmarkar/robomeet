# Stage research digest (2026-09-15)

Sources: research workflow wf_1ce318fc-262 (OpenAI GPT Live docs via the openai-docs MCP; a design critique that ran
probes in Chrome 144), plus the offline oracle `tools/present-lab/fixture.mjs` (run `tools/present-lab/runs/iter0`).

## Measured (offline oracle, iteration 0)
| Path | Received | SSIM-Y | PSNR-Y | Encoder limit |
|---|---|---|---|---|
| old path (renderer -> bridge -> 1280x720 canvas), no contentHint | 480x270 to 640x360 | 0.85-0.89 | 20-21 dB | bandwidth |
| new stage, exact 1920x1080 view render, contentHint detail | 1920x1080 | 0.999 | 51-52 dB | none |
| new stage, view resampled from a 2400 px page | 1920x1080 | 0.984 | 28 dB | none |
- VP8, VP9 and AV1, 2.5 Mbps and 0.8 Mbps caps all show the same pattern.
- contentHint '' or 'motion' -> 480x270. 'detail' or 'text' -> 1920x1080, and outbound/inbound `contentType: 'screenshare'`.
- Idle repaint every 33 or 100 ms: equal quality. Every 250 ms: worse (PSNR 48 dB).
- A 700 ms scroll arrives at about 8 fps at 1080p within the cap (encoder keeps resolution, drops frames).

## GPT Live facts (docs)
- No event marks the start or end of the model's speech on any channel. Track playback in the client. The page's
  output meter (`src/meet-live.js`) is the only real signal. It reads after the speak gate, so it is silent unless
  mode is 'speak'.
- `session.instructions.append` requests exact wording, not guaranteed. An instruction appended while the model is
  speaking can interrupt it. Acks (`session.instructions.appended`) must be matched by `client_event_id`, and they
  do not mean the model spoke. `session.commentary.append` may paraphrase. There is no cancel. Each append is
  limited to 500 tokens.
- The voice model cannot call tools directly. Tools run only through delegation. For fast UI changes, react to
  transcript deltas in the app. Use `session.thinking.append` (delegation_id null) to tell the model what is on screen.
- Re-attaching the sideband to the same session id fits the documented contract, but is untested. Events during the
  gap are lost. Losing the sideband is not documented to end the session. RoboMeet ends it by its own choice
  (`live.mjs` socket close -> close session).
- Barge-in is model-controlled. There are no user-speech events and no settings.
- Measured live 2026-09-15: an instruction appended while the model speaks does stop it. RoboMeet's "stop talking"
  instruction silenced the robot 0.6 s after it was sent (0.77-0.88 s at the other participant).
- Measured live: input transcription can invent words in a silent room ("this slide presents", no audio at all).
  Gate "a person is speaking" on real meeting audio (`stage-input`), not on transcripts alone.
- Measured live: in its own words the model paraphrases ("sin" for "sine", "2" for "two"); compare normalized content
  words, not exact tokens. After "continue" it often carries on by itself before any cue.

## Design critique (ranked) -> decisions
1. Beat end: never cue while the robot speaks. Require an active session in 'speak' mode. Match acks by id. A beat
   is done when most of its words appeared in the output transcript and output has been quiet for a moment, with a
   longer-silence fallback.
2. Playwright init scripts run in every frame: the stage must return early unless `window.top === window`. Decoded
   pages are big; keep blobs, decode only neighbours.
3. Track sharing from the clones Meet holds (wrap `stop()`), not a cached flag. Share off: stop clones and dispatch
   `ended`, then fall back to clicking.
4. Meet may call `applyConstraints` to cap size or fps while getSettings still says 1920x1080. Read Meet's
   outbound-rtp for the stage track (a peer-connection proxy) instead.
5. Pause on real speech (input transcript words), not RMS. Resume only on a short standalone "continue / go on /
   next". Ignore echo of the robot's own words.
6. Tie narration to visible content: the deck lists the text of each view, and a contact sheet lets the coding agent
   check each beat by eye.
7. Paint cost: 'high' smoothing is about 22 ms/frame in software. Draw motion frames from a 1920-wide copy with low
   smoothing, and exact renders 1:1 at rest.
8. Playwright can pass Uint8Array to page.evaluate directly (no base64).
9-12. Stage first in teardown; instance id for reloads; never auto-share at join; pause and re-cue on a voice
   restart; tell the model what is on screen at every beat.

## WebRTC encoder facts (libwebrtc/Chromium source + probes in Chrome 144, research agent)
- 'detail' and 'text' set is_screencast: codec screen-content mode (VP8 mode 2, VP9/AV1 screen tuning, AV1 palette),
  MAINTAIN_RESOLUTION, no quality-scaler downscaling, no denoising, a 100 kbps padding floor. 'text' behaves exactly
  like 'detail' in libwebrtc today. An explicit RTCRtpSendParameters.degradationPreference set by Meet overrides the
  degradation default but not the screen-content coding.
- The hint survives clone(), replaceTrack() and new MediaStream(); it is lost through a MediaStreamTrackProcessor ->
  generator pipeline.
- Without a hint a canvas track starts at 320x180 and needs about 20 s to reach 720p even on a perfect link.
- A canvas track emits frames only when painted. Keep about 10 fps of identical redraws while still (it sharpens as
  fast as 30 fps); 30 fps only while moving. Draw-on-change with WebRTC's zero-hertz repeats stalled VP8 at 1 fps /
  maximum QP after a slide change (3 of 3 runs). After a change, VP8 text is sharp in about 2.3-4 s, VP9/AV1 1-3 s.
- captureStream(0) reports getSettings().frameRate 0; report 30 on the clone Meet receives.
- Meet reportedly sends screen shares as VP8 simulcast on a separate peer connection (2023); receivers get the layer
  matching their tile size. Prefer cuts/crossfades to animated zooms (block motion prediction handles translation,
  not zoom). Start sharing a few seconds before narrating (fresh bandwidth estimate at 300 kbps).
- Verify inside Meet: outbound-rtp for the clone's trackIdentifier: contentType 'screenshare', 1920x1080, fps, QP
  per frame (converged: VP8 ~15, VP9 ~32, AV1 ~40-60), qualityLimitationReason. Log Meet's contentHint writes,
  setParameters (degradationPreference, maxBitrate, scaleResolutionDownBy) and applyConstraints on our tracks.
