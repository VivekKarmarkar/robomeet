# RoboMeet stage — design contract (2026-09-15)

Goal and test cases: `docs/presentation-spec.md`. This file fixes the interfaces so modules can be built
and tested independently. New files only, plus small marked hooks in existing files ("stage:" comments).
The bridged slide video in `src/meet-media.js` stays untouched as the fallback.

## Coordinates
- Stage canvas: 1920 x 1080, drawn inside the Meet page.
- A deck is a list of slides. A slide shows one picture (asset) or text. Positions inside a slide are
  normalized to the slide picture: x, y, w, h in 0..1 of its width and height.
- A view is a rectangle of the slide that fills the stage (letterboxed if its aspect is not 16:9).
  `{ x, y, w, h, highlight?: {x,y,w,h}, asset?: '<exact render id>', say?: '<narration>' }`.
  `asset` is an optional pixel-exact 1920x1080 render of exactly that view, drawn 1:1 once the camera rests.
- Position in the deck = { slide, view }. Next = next view of the slide, else first view of the next slide.

## Store (src/store.mjs state, persisted)
- Existing fields keep their meaning: `title`, `slides[] {title, body}`, `slideIndex`.
- Slides may also carry `views[]` (above). `body` stays `image:/slides/<path>` or plain text.
- New field `viewIndex` (default 0). New field `presenter` { status: idle|running|paused|done|stopped,
  beat, total, reason }.

## In-page stage: `src/meet-stage.js` → `window.RoboMeetStage`
Injected after `meet-media.js` and `meet-live.js`. Wraps `navigator.mediaDevices.getDisplayMedia` so Meet's
"Present now" receives a clone of the stage track (contentHint set); `close()` restores the wrapped function.
- `putAsset(id, base64, mime)` → `{ id, width, height }` (Blob + createImageBitmap; no img-src, no taint).
- `hasAssets(ids[])` → ids already present.
- `setDeck({ title, slides: [{ kind: 'image'|'text', asset?, title, body, views[] }] })`.
- `show({ slide, view, transitionMs? })` → animates the camera; returns `{ changedAt }` (Date.now()).
- `clear()` → idle picture.
- `health()` → `{ frames, fps, slide, view, moving, lastChangeAt, settledAt, displayRequests,
  lastConstraints, contentHint, trackSettings, speech: { speaking, onsetAt, endAt } }`.
- Events via `window.__robomeetStageEvent(data)`: `stage-changed`, `stage-settled`, `stage-display-request`,
  `stage-speech` { phase: 'onset'|'end', at } (from `window.RoboMeetLive.health()` output metering).
- `close()`.

## Node
- `src/stage-sync.mjs` (worker side): mirrors store `slides/title/slideIndex/viewIndex` into the page:
  reads `public/slides/**` files, pushes assets lazily (current, next, previous), calls `show`. Clears the
  stage when a meeting starts.
- `src/deck-builder.mjs` + `bin/deck.mjs`: PDF → `public/slides/<slug>/` page images, per-page default
  fit-width views snapped between text lines, exact 1920x1080 renders per view, and a `deck.json` with the
  text lines inside each view (so the coding agent can write narration and pick highlights).
- `src/presenter.mjs` (server side): runs a narrated walk over views that have `say`. Per beat: move the
  stage, speak (live.announce), wait for speech end (stage-speech end, or timeout by length), next. Pauses when
  a person talks; resumes on "continue / go on / next / keep going" in the user transcript or a command.
- Server commands: `stage` (show position), `present` (existing; now keeps `views`), `present-deck`
  (deck.json), `narrate` (start), `presenter` (pause|resume|stop|next|previous). MCP tools mirror them.
