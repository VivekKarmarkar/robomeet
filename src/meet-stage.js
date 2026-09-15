/* RoboMeet stage: the picture RoboMeet shares into the meeting, drawn inside the Meet page itself.
 *
 * Why (docs/presentation-spec.md): the old path drew slides in a separate renderer tab, sent them through a
 * local WebRTC encode/decode, then redrew them on a 1280x720 canvas here. Meet received a twice-compressed
 * 720p picture marked as camera video. This stage draws at 1920x1080 in this page, so Meet's own encoder is
 * the only compression, and it marks the track as detail content so Chrome encodes it as a screen share.
 *
 * Injected after src/meet-media.js and src/meet-live.js. It wraps navigator.mediaDevices.getDisplayMedia, so
 * Meet's "Present now" receives a clone of the stage track; close() puts the wrapped function back. The
 * bridged slide video in meet-media.js is untouched and remains the fallback when this script is absent.
 * Contract: docs/stage-design.md.
 *
 * Sharing state comes from the clones Meet holds (their stop() is wrapped, readyState is polled). stats() reads Meet's
 * own outbound-rtp for those clones through a third RTCPeerConnection proxy, stacked on meet-media's and meet-live's.
 */
(() => {
  if (window.top !== window) return; // Playwright runs init scripts in every frame; the stage belongs to Meet's top page
  if (window.RoboMeetStage) return;
  const W = 1920;
  const H = 1080;
  // Tunables (configure() changes them; tools/present-lab measures their effect).
  const tune = {
    moveMs: 700, // a scroll or zoom inside one slide, eased like a person scrolling
    fadeMs: 280, // a change of slide
    highlightMs: 320,
    idleFrameMs: 100, // steady 10 fps while still, so the encoder keeps refining the picture
    speechEndMs: 800, // robot output silent this long after speaking = the utterance ended
    hint: 'detail', // MediaStreamTrack.contentHint for the shared track
  };
  const MAX_DECODED = 6; // decoded pictures kept in memory (full + fit copy); compressed blobs are kept for every asset
  const UNSHARED_FRAME_MS = 1000; // nobody receives the track while not sharing: repaint once a second
  const BACKGROUND = '#202124';
  const instance = crypto.randomUUID?.() || Math.random().toString(36).slice(2); // per page load, so Node can spot a reload

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  const still = document.createElement('canvas'); // the settled frame, blitted on idle frames
  still.width = W;
  still.height = H;
  const stillCtx = still.getContext('2d', { alpha: false });
  const outgoing = document.createElement('canvas'); // the half-blended frame a change interrupted mid-crossfade
  outgoing.width = W;
  outgoing.height = H;
  const outgoingCtx = outgoing.getContext('2d', { alpha: false });
  const master = canvas.captureStream(0).getVideoTracks()[0];
  try { master.contentHint = tune.hint; } catch {}

  const assets = new Map(); // id -> { blob, bitmap, fit, width, height, used, decoding }; fit: 1920-wide copy of wider pictures
  let deck = { title: '', slides: [] };
  let target = null; // { slide, view, rect }
  let from = null; // { slide, rect } drawn when the current transition started
  let motion = { kind: 'none', start: 0, duration: 0 };
  let settledAt = null;
  let lastChangeAt = null;
  let stillValid = false;
  let dirty = true;
  let lastFrameAt = 0;
  let frames = 0;
  const frameTimes = [];
  let displayRequests = 0;
  let lastConstraints = null;
  const constraintLog = [];
  const clones = new Set(); // every track handed to Meet
  const stoppedClones = new WeakSet(); // clones whose stop() ran (Meet stopped presenting, endShare, close)
  let sharing = false;
  let closed = false;
  const speech = { speaking: false, onsetAt: null, endAt: null, lastOnset: null };
  // Meeting audio from the other participants (src/meet-live.js input meter): the presenter only treats a transcript
  // as a person speaking when there was audio behind it (speech recognition can invent words from near-silence).
  const input = { speaking: false, onsetAt: null, endAt: null, lastHeard: null };
  const INPUT_END_MS = 700;

  const event = data => {
    try { Promise.resolve(window.__robomeetStageEvent?.(data)).catch(() => {}); } catch {}
  };
  const clamp01 = value => Math.min(1, Math.max(0, value));
  const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerpRect = (a, b, t) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) });
  function cleanRect(rect, fallback = { x: 0, y: 0, w: 1, h: 1 }) {
    if (!rect || typeof rect !== 'object') return { ...fallback };
    const w = Math.min(1, Math.max(0.02, Number(rect.w) || fallback.w));
    const h = Math.min(1, Math.max(0.02, Number(rect.h) || fallback.h));
    const x = Math.min(1 - w, Math.max(0, Number(rect.x) || 0));
    const y = Math.min(1 - h, Math.max(0, Number(rect.y) || 0));
    return { x, y, w, h };
  }

  // ---- assets: compressed bytes arrive from Node; Blob + createImageBitmap avoids img-src CSP and canvas taint.
  // Bytes: a Uint8Array or ArrayBuffer (no base64 round trip), or a base64 string. A Node Buffer is neither: Playwright
  // (1.63) hands it to the page as a plain {0: .., 1: ..} object, so Node must pass new Uint8Array(buffer).
  function assetBytes(data) {
    if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) return data;
    if (typeof data !== 'string') throw new TypeError('putAsset needs a Uint8Array, an ArrayBuffer or a base64 string (from Node, pass new Uint8Array(buffer), not a Buffer).');
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  // The full picture, plus for pictures wider than the stage a 1920-wide copy: motion frames of fit-width views sample
  // it about 1:1 with 'low' smoothing (measured 2026-09-14: about half the paint time of the full 2400 px picture).
  async function decodePicture(blob) {
    const bitmap = await createImageBitmap(blob);
    if (bitmap.width <= W) return { bitmap, fit: null };
    try { return { bitmap, fit: await createImageBitmap(blob, { resizeWidth: W, resizeQuality: 'high' }) }; }
    catch { return { bitmap, fit: null }; } // motion frames then sample the full picture
  }
  async function putAsset(id, data, mime = 'image/png') {
    if (closed) throw new Error('The stage is closed.');
    const blob = new Blob([assetBytes(data)], { type: mime });
    const { bitmap, fit } = await decodePicture(blob);
    const old = assets.get(id);
    old?.bitmap?.close?.();
    old?.fit?.close?.();
    assets.set(id, { blob, bitmap, fit, width: bitmap.width, height: bitmap.height, used: performance.now(), decoding: null });
    trimDecoded();
    dirty = true;
    stillValid = false;
    return { id, width: bitmap.width, height: bitmap.height };
  }
  function hasAssets(ids = []) { return ids.filter(id => assets.has(id)); }
  function trimDecoded() {
    const decoded = [...assets.entries()].filter(([, entry]) => entry.bitmap).sort((a, b) => b[1].used - a[1].used);
    const keep = new Set(neededIds());
    for (const [id, entry] of decoded.slice(MAX_DECODED)) {
      if (keep.has(id)) continue;
      entry.bitmap.close?.();
      entry.fit?.close?.();
      entry.bitmap = null;
      entry.fit = null;
    }
  }
  async function decoded(id) {
    const entry = id && assets.get(id);
    if (!entry) return null;
    entry.used = performance.now();
    if (entry.bitmap) return entry.bitmap;
    entry.decoding ??= decodePicture(entry.blob).then(({ bitmap, fit }) => {
      entry.decoding = null;
      if (assets.get(id) !== entry) { bitmap.close(); fit?.close(); return null; } // replaced or cleared while decoding
      entry.bitmap = bitmap;
      entry.fit = fit;
      trimDecoded();
      return bitmap;
    }, error => { entry.decoding = null; throw error; });
    return entry.decoding;
  }
  // The asset entry if its picture is decoded; otherwise starts decoding (a later frame paints it) and returns null.
  function decodedNow(id) {
    const entry = id && assets.get(id);
    if (!entry) return null;
    entry.used = performance.now();
    if (!entry.bitmap) { void decoded(id).then(() => { dirty = true; }, () => {}); return null; }
    return entry;
  }
  const bitmapNow = id => decodedNow(id)?.bitmap || null;
  function neededIds() {
    const ids = [];
    for (const place of [target, from]) {
      if (!place) continue;
      const slide = deck?.slides?.[place.slide];
      if (slide?.asset) ids.push(slide.asset);
      const view = slide?.views?.[place.view];
      if (view?.asset) ids.push(view.asset);
    }
    return ids;
  }

  // ---- deck and camera
  // setDeck stages the deck; the next show() swaps it in only after its pictures are decoded, so the meeting
  // never sees a blank frame between two decks.
  let pendingDeck = null;
  function normalizeDeck(next = {}) {
    const slides = Array.isArray(next.slides) ? next.slides.slice(0, 400) : [];
    return {
      title: String(next.title || '').slice(0, 300),
      slides: slides.map(slide => ({
        kind: slide?.kind === 'image' && slide.asset ? 'image' : 'text',
        asset: slide?.asset ? String(slide.asset) : null,
        title: String(slide?.title || '').slice(0, 300),
        body: String(slide?.body || '').slice(0, 5000),
        views: (Array.isArray(slide?.views) && slide.views.length ? slide.views : [{}]).slice(0, 200).map(view => ({
          ...cleanRect(view),
          highlight: view?.highlight ? cleanRect(view.highlight) : null,
          asset: view?.asset ? String(view.asset) : null,
        })),
      })),
    };
  }
  function setDeck(next = {}) {
    pendingDeck = normalizeDeck(next);
    return { slides: pendingDeck.slides.length };
  }
  async function show({ slide = 0, view = 0, transitionMs } = {}) {
    if (closed) throw new Error('The stage is closed.');
    const incoming = pendingDeck;
    const source = incoming || deck;
    const item = source.slides[slide];
    if (!item) throw new Error(`Slide ${slide} is not in the deck.`);
    const index = Math.min(Math.max(0, Number(view) || 0), item.views.length - 1);
    const wanted = item.views[index];
    await Promise.all([decoded(item.asset), decoded(wanted.asset)]);
    if (incoming) {
      if (pendingDeck !== incoming) return show({ slide, view, transitionMs }); // replaced while decoding
      deck = incoming;
      pendingDeck = null;
      target = null; // a new deck cuts in; there is nothing of it on stage to scroll from
      from = null;
      motion = { kind: 'none', start: 0, duration: 0 };
    }
    const rect = { x: wanted.x, y: wanted.y, w: wanted.w, h: wanted.h };
    const now = performance.now();
    if (target && target.slide === slide && target.view === index && progress(now) >= 1) return { changedAt: lastChangeAt, slide, view: index, kind: 'none' };
    const current = currentCamera(now);
    // A change during a crossfade fades on from the half-blended frame on screen, not from its target at full weight
    // (that would cut to the target for one frame).
    const midFade = motion.kind === 'fade' && progress(now) < 1;
    if (midFade) outgoingCtx.drawImage(canvas, 0, 0);
    const sameSlide = current && current.slide === slide;
    // A pure scroll animates; a zoom (the view changes size) crossfades: video codecs predict translation well and
    // zoom badly, so an animated zoom arrives as a few blurry frames (docs/stage-research.md).
    const scroll = !midFade && sameSlide && Math.abs(current.rect.w - rect.w) < 0.02 && Math.abs(current.rect.h - rect.h) < 0.02;
    const duration = transitionMs !== undefined ? Math.max(0, Number(transitionMs) || 0) : scroll ? tune.moveMs : tune.fadeMs;
    from = midFade && current ? { ...current, snapshot: true } : current;
    target = { slide, view: index, rect };
    motion = { kind: !current || duration === 0 ? 'none' : scroll ? 'move' : 'fade', start: now, duration };
    settledAt = motion.kind === 'none' ? Date.now() : null;
    lastChangeAt = Date.now();
    stillValid = false;
    dirty = true;
    tick();
    event({ type: 'stage-changed', slide, view: index, kind: motion.kind, at: lastChangeAt });
    return { changedAt: lastChangeAt, slide, view: index, kind: motion.kind };
  }
  function clear() {
    pendingDeck = null;
    target = null;
    from = null;
    motion = { kind: 'none', start: 0, duration: 0 };
    deck = { title: '', slides: [] };
    for (const entry of assets.values()) { entry.bitmap?.close?.(); entry.fit?.close?.(); }
    assets.clear();
    lastChangeAt = Date.now();
    settledAt = lastChangeAt;
    stillValid = false;
    dirty = true;
    return true;
  }
  function progress(now) {
    if (motion.kind === 'none' || !motion.duration) return 1;
    return clamp01((now - motion.start) / motion.duration);
  }
  function currentCamera(now) {
    if (!target) return null;
    const t = progress(now);
    if (motion.kind === 'move' && t < 1 && from) return { slide: target.slide, view: target.view, rect: lerpRect(from.rect, target.rect, ease(t)) };
    return { slide: target.slide, view: target.view, rect: target.rect };
  }

  // ---- painting
  function drawIdle(context) {
    context.fillStyle = BACKGROUND;
    context.fillRect(0, 0, W, H);
    context.fillStyle = '#9aa0a6';
    context.font = '500 44px system-ui, sans-serif';
    context.textAlign = 'center';
    context.fillText('RoboMeet', W / 2, H / 2);
    context.textAlign = 'left';
  }
  // Returns the mapping from slide-normalized coordinates to the canvas, or null when nothing was drawn.
  // Settled frames sample the full picture with 'high' smoothing. Motion frames: fit-width views (w >= 0.99) sample the
  // 1920-wide copy with 'low', zoomed views the full picture with 'medium' (docs/stage-research.md, critique item 7).
  function drawCamera(context, slideIndex, rect, moving) {
    const slide = deck.slides[slideIndex];
    if (!slide) return null;
    if (slide.kind === 'text') { drawTextSlide(context, slide, slideIndex); return { ox: 0, oy: 0, sx: W, sy: H, rect: { x: 0, y: 0, w: 1, h: 1 } }; }
    const entry = decodedNow(slide.asset);
    if (!entry) return null;
    const fast = Boolean(moving && rect.w >= 0.99 && entry.fit);
    const bitmap = fast ? entry.fit : entry.bitmap;
    const sw = rect.w * bitmap.width;
    const sh = rect.h * bitmap.height;
    const scale = Math.min(W / sw, H / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    const dx = (W - dw) / 2;
    const dy = (H - dh) / 2;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = fast ? 'low' : moving ? 'medium' : 'high';
    context.drawImage(bitmap, rect.x * bitmap.width, rect.y * bitmap.height, sw, sh, dx, dy, dw, dh);
    // canvas = offset + (normalized - rect.origin) * size-in-canvas-per-normalized-unit
    return { ox: dx, oy: dy, sx: dw / rect.w, sy: dh / rect.h, rect };
  }
  function drawHighlight(context, map, box, alpha) {
    if (!map || !box || alpha <= 0) return;
    const pad = 14;
    const x = map.ox + (box.x - map.rect.x) * map.sx - pad;
    const y = map.oy + (box.y - map.rect.y) * map.sy - pad;
    const w = box.w * map.sx + pad * 2;
    const h = box.h * map.sy + pad * 2;
    context.save();
    context.globalAlpha = alpha;
    context.fillStyle = 'rgba(251, 188, 4, 0.10)';
    context.strokeStyle = '#f9ab00';
    context.lineWidth = 6;
    context.shadowColor = 'rgba(249, 171, 0, 0.55)';
    context.shadowBlur = 18;
    context.beginPath();
    context.roundRect(x, y, w, h, 16);
    context.fill();
    context.stroke();
    context.restore();
  }
  function wrap(context, text, maxWidth) {
    const lines = [];
    for (const paragraph of String(text || '').split('\n')) {
      let line = '';
      for (const word of paragraph.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (line && context.measureText(next).width > maxWidth) { lines.push(line); line = word; } else line = next;
      }
      lines.push(line);
    }
    return lines;
  }
  // Same layout as public/media.js paintSlides (designed at 1280x720), scaled to the 1920x1080 stage.
  function drawTextSlide(context, slide, index) {
    context.save();
    context.scale(W / 1280, H / 720);
    context.fillStyle = '#eee7cf';
    context.fillRect(0, 0, 1280, 720);
    context.fillStyle = '#d8d1b5';
    context.fillRect(68, 73, 31, 7);
    context.font = '600 16px system-ui, sans-serif';
    context.fillStyle = '#61705c';
    context.fillText((deck.title || 'ROBOMEET · PRESENTATION').slice(0, 85).toUpperCase(), 114, 86);
    context.fillStyle = '#263e2d';
    context.font = '600 62px system-ui, sans-serif';
    let y = 204;
    for (const line of wrap(context, slide.title || 'Untitled slide', 1100).slice(0, 3)) { context.fillText(line, 74, y); y += 77; }
    y += 27;
    context.font = '28px system-ui, sans-serif';
    context.fillStyle = '#4d5e48';
    for (const line of wrap(context, slide.body, 1100).slice(0, Math.floor((620 - y) / 43))) { context.fillText(line, 78, y); y += 43; }
    context.fillStyle = '#8b967d';
    context.fillRect(74, 652, 1132, 1);
    context.font = '16px system-ui, sans-serif';
    context.fillText('RoboMeet', 75, 683);
    context.textAlign = 'right';
    context.fillText(`${index + 1} / ${deck.slides.length}`, 1204, 683);
    context.restore();
  }
  function paintSettled(context, highlightAlpha = 1) {
    context.fillStyle = BACKGROUND;
    context.fillRect(0, 0, W, H);
    if (!target) { drawIdle(context); return true; }
    const slide = deck.slides[target.slide];
    const view = slide?.views?.[target.view];
    const exact = view?.asset ? bitmapNow(view.asset) : null;
    let map;
    if (exact) {
      // A pixel-exact render of this view: draw it 1:1 when it matches the stage, otherwise fit it.
      const scale = Math.min(W / exact.width, H / exact.height);
      const dw = exact.width * scale;
      const dh = exact.height * scale;
      context.imageSmoothingEnabled = scale !== 1;
      context.imageSmoothingQuality = 'high';
      context.drawImage(exact, (W - dw) / 2, (H - dh) / 2, dw, dh);
      map = { ox: (W - dw) / 2, oy: (H - dh) / 2, sx: dw / target.rect.w, sy: dh / target.rect.h, rect: target.rect };
    } else map = drawCamera(context, target.slide, target.rect, false);
    if (!map) return false;
    drawHighlight(context, map, view?.highlight, highlightAlpha);
    return true;
  }
  function paint(now) {
    const t = progress(now);
    const settled = t >= 1;
    if (settled) {
      const highlightAge = settledAt ? Date.now() - settledAt : tune.highlightMs;
      const view = target ? deck.slides[target.slide]?.views?.[target.view] : null;
      const fading = view?.highlight && highlightAge < tune.highlightMs;
      if (!stillValid && !fading) stillValid = paintSettled(stillCtx);
      if (stillValid) { ctx.drawImage(still, 0, 0); return; }
      // Highlight still fading in: the same pixel-exact view, with the highlight at its current strength.
      if (fading && paintSettled(ctx, clamp01(highlightAge / tune.highlightMs))) return;
      // The settled frame is not decodable yet: draw live from the page picture.
      ctx.fillStyle = BACKGROUND;
      ctx.fillRect(0, 0, W, H);
      if (!target) { drawIdle(ctx); return; }
      const map = drawCamera(ctx, target.slide, target.rect, false);
      drawHighlight(ctx, map, view?.highlight, clamp01(highlightAge / tune.highlightMs));
      return;
    }
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, W, H);
    const e = ease(t);
    if (motion.kind === 'move') {
      drawCamera(ctx, target.slide, lerpRect(from.rect, target.rect, e), true);
    } else if (motion.kind === 'fade') {
      if (from?.snapshot) ctx.drawImage(outgoing, 0, 0);
      else if (from) drawCamera(ctx, from.slide, from.rect, true);
      ctx.globalAlpha = e;
      ctx.fillStyle = BACKGROUND;
      ctx.fillRect(0, 0, W, H);
      drawCamera(ctx, target.slide, target.rect, true);
      ctx.globalAlpha = 1;
    }
  }

  // ---- frame loop: 30 fps while moving or fading, 10 fps while still and shared, 1 fps while not shared, and a paint
  // right after any change (every frame is repainted so a frame is captured)
  let wasMoving = false;
  const TICK_MS = 33;
  function tick() {
    if (closed) return;
    updateSharing(); // a clone can also end without its stop(), e.g. when its source ends
    const now = performance.now();
    const moving = motion.kind !== 'none' && progress(now) < 1;
    const view = target ? deck.slides[target.slide]?.views?.[target.view] : null;
    const highlightFading = !moving && view?.highlight && settledAt && Date.now() - settledAt < tune.highlightMs;
    if (wasMoving && !moving) {
      settledAt = Date.now();
      stillValid = false;
      dirty = true; // the settled frame is a change: paint it now, not at the next idle slot
      event({ type: 'stage-settled', slide: target?.slide, view: target?.view, at: settledAt });
    }
    wasMoving = moving;
    const due = moving || highlightFading || dirty ? 0 : sharing ? tune.idleFrameMs : UNSHARED_FRAME_MS;
    if (due && now - lastFrameAt < due - TICK_MS / 2) return; // half a tick of slack: 100 ms idle is every 3rd tick
    paint(now);
    dirty = false;
    try { master.requestFrame(); } catch {}
    lastFrameAt = now;
    frames++;
    frameTimes.push(now);
    while (frameTimes.length && now - frameTimes[0] > 1000) frameTimes.shift();
  }
  const frameTimer = setInterval(tick, TICK_MS);

  // ---- speech watcher: onset/end of the robot's own voice, from src/meet-live.js output metering
  const speechTimer = setInterval(() => {
    const live = window.RoboMeetLive?.health?.();
    if (!live) return;
    const now = Date.now();
    if (live.outputOnsetAt && live.outputOnsetAt !== speech.lastOnset) {
      speech.lastOnset = live.outputOnsetAt;
      speech.speaking = true;
      speech.onsetAt = live.outputOnsetAt;
      event({ type: 'stage-speech', phase: 'onset', at: live.outputOnsetAt, slide: target?.slide ?? null, view: target?.view ?? null });
    }
    if (speech.speaking && live.lastOutputAudibleAt && now - live.lastOutputAudibleAt >= tune.speechEndMs) {
      speech.speaking = false;
      speech.endAt = live.lastOutputAudibleAt;
      event({ type: 'stage-speech', phase: 'end', at: live.lastOutputAudibleAt, slide: target?.slide ?? null, view: target?.view ?? null });
    }
    const heard = live.lastInputAudibleAt;
    if (heard && heard !== input.lastHeard) {
      input.lastHeard = heard;
      if (!input.speaking) { input.speaking = true; input.onsetAt = heard; event({ type: 'stage-input', phase: 'onset', at: heard }); }
    }
    if (input.speaking && heard && now - heard >= INPUT_END_MS) { input.speaking = false; input.endAt = heard; event({ type: 'stage-input', phase: 'end', at: heard }); }
  }, 50);

  // ---- sharing: Meet is presenting while it holds at least one live clone of the stage track
  const isLive = track => track.readyState === 'live' && !stoppedClones.has(track);
  const liveCloneCount = () => [...clones].filter(isLive).length;
  function updateSharing() {
    const liveClones = liveCloneCount();
    if ((liveClones > 0) === sharing) return;
    sharing = liveClones > 0;
    dirty = true;
    event({ type: 'stage-sharing', sharing, liveClones, at: Date.now() });
  }

  // ---- stats probe: what Meet really encodes from the stage (TC-R5). Meet may applyConstraints() a clone down while
  // its getSettings() still says 1920x1080. Same construct-only proxy as meet-media.js and meet-live.js, stacked on
  // theirs: `.prototype` still falls through to the native constructor, and both layers below still see every peer.
  const PriorPeerConnection = window.RTCPeerConnection;
  const meetPeers = new Set();
  const peerGone = peer => peer.connectionState === 'closed' || peer.signalingState === 'closed'; // 'failed' can recover (ICE restart)
  const StagePeerConnection = new Proxy(PriorPeerConnection, {
    construct(Target, args) {
      const peer = Reflect.construct(Target, args);
      if (closed) return peer;
      meetPeers.add(peer);
      peer.addEventListener('connectionstatechange', () => { if (peerGone(peer)) meetPeers.delete(peer); });
      return peer;
    },
  });
  window.RTCPeerConnection = StagePeerConnection;
  const STAT_KEYS = ['frameWidth', 'frameHeight', 'framesPerSecond', 'contentType', 'qualityLimitationReason', 'encoderImplementation', 'scalabilityMode', 'targetBitrate', 'bytesSent'];
  // Outbound video reports whose media source is one of the clones handed to Meet, each with its codec's mimeType.
  async function stats() {
    const ids = new Set([...clones].map(track => track.id));
    const reports = [];
    for (const peer of [...meetPeers]) {
      if (peerGone(peer)) { meetPeers.delete(peer); continue; } // close() fires no connectionstatechange
      let all;
      try { all = await peer.getStats(); } catch { continue; }
      for (const report of all.values()) {
        if (report.type !== 'outbound-rtp' || report.kind !== 'video') continue;
        const ours = ids.has(all.get(report.mediaSourceId)?.trackIdentifier);
        if (!ours && report.contentType !== 'screenshare') continue; // Meet's presentation stream, whatever track feeds it
        if (report.mid != null) for (const transceiver of peer.getTransceivers?.() || []) if (transceiver.mid === report.mid) screenSenders.add(transceiver.sender);
        const item = { matchedBy: ours ? 'track' : 'contentType' };
        for (const key of STAT_KEYS) if (report[key] !== undefined) item[key] = report[key];
        item.codec = all.get(report.codecId)?.mimeType ?? null;
        reports.push(item);
      }
    }
    return reports;
  }
  // The send parameters Meet has set on the senders carrying our clones (degradation preference, bitrate, scaling).
  async function senders() {
    await stats().catch(() => []); // learns which senders carry the screenshare stream
    const out = [];
    for (const peer of [...meetPeers]) {
      if (peerGone(peer)) continue;
      for (const sender of peer.getSenders?.() || []) {
        const matchedBy = senderMatch(sender);
        if (matchedBy) { try { out.push({ matchedBy, ...summarizeParameters(sender.getParameters()) }); } catch {} }
      }
    }
    return out;
  }

  // ---- what Meet does to the shared track: contentHint writes and sender parameters (degradation, bitrate, scaling)
  const hintAccessor = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'contentHint');
  const hintWrites = [];
  const senderLog = [];
  const screenSenders = new WeakSet();
  const senderMatch = sender => {
    const track = sender?.track;
    if (track && clones.has(track)) return 'track';
    if (screenSenders.has(sender)) return 'contentType';
    if (track?.kind === 'video' && (track.contentHint === 'detail' || track.contentHint === 'text')) return 'hint';
    return null;
  };
  const nativeSetParameters = RTCRtpSender.prototype.setParameters;
  const summarizeParameters = params => ({ degradationPreference: params?.degradationPreference ?? null, encodings: (params?.encodings || []).map(item => ({ rid: item.rid, active: item.active, maxBitrate: item.maxBitrate, maxFramerate: item.maxFramerate, scaleResolutionDownBy: item.scaleResolutionDownBy, scalabilityMode: item.scalabilityMode })) });
  const stageSetParameters = function (params, ...rest) {
    try { const matchedBy = senderMatch(this); if (matchedBy) { senderLog.push({ at: Date.now(), matchedBy, ...summarizeParameters(params) }); if (senderLog.length > 20) senderLog.shift(); } } catch {}
    return nativeSetParameters.call(this, params, ...rest);
  };
  RTCRtpSender.prototype.setParameters = stageSetParameters;

  // Every track handed to Meet, and every clone Meet makes of one (live stats showed Meet sending a track we did not
  // hand out), gets the same guards: screen-content hint that Meet cannot downgrade, 1920x1080 at 30 fps settings,
  // logged applyConstraints, stop() recorded for the sharing state, clone() adopting the new track.
  function adopt(track) {
    try { track.contentHint = tune.hint; } catch {}
    if (hintAccessor) Object.defineProperty(track, 'contentHint', { configurable: true, get: () => hintAccessor.get.call(track), set: value => {
      hintWrites.push({ at: Date.now(), value: String(value) });
      if (hintWrites.length > 20) hintWrites.shift();
      if (value === 'detail' || value === 'text' || value === tune.hint) hintAccessor.set.call(track, value);
    } });
    const settings = track.getSettings.bind(track);
    // captureStream(0) reports frameRate 0; a real screen capture reports its rate, and Meet may size its encoder by it.
    track.getSettings = () => ({ ...settings(), width: W, height: H, frameRate: 30, displaySurface: 'browser', logicalSurface: true });
    const apply = track.applyConstraints.bind(track);
    track.applyConstraints = async value => {
      constraintLog.push({ at: Date.now(), constraints: summarize(value) });
      if (constraintLog.length > 20) constraintLog.shift();
      return apply(value);
    };
    // Meet stops the track when it stops presenting: that, not a cached flag, is the sharing state.
    const stop = track.stop.bind(track);
    track.stop = () => { stoppedClones.add(track); stop(); updateSharing(); };
    const clone = track.clone.bind(track);
    track.clone = () => adopt(clone());
    clones.add(track);
    return track;
  }

  // ---- getDisplayMedia: Meet's "Present now" gets a clone of the stage track
  const wrapped = navigator.mediaDevices.getDisplayMedia;
  const summarize = value => { try { return JSON.parse(JSON.stringify(value ?? null)); } catch { return String(value); } };
  const stageGetDisplayMedia = async function (constraints) {
    // Closed (a caller kept this wrapper): do exactly what the wrapped function does. meet-media.js's throws
    // InvalidStateError once it is closed as well, and otherwise hands out its own screen track.
    if (closed) return wrapped.call(navigator.mediaDevices, constraints);
    if (constraints?.video === false) throw new TypeError('Screen sharing requires video');
    displayRequests++;
    lastConstraints = summarize(constraints);
    const track = adopt(master.clone());
    dirty = true;
    event({ type: 'stage-display-request', constraints: lastConstraints, at: Date.now() });
    updateSharing();
    return new MediaStream([track]);
  };
  navigator.mediaDevices.getDisplayMedia = stageGetDisplayMedia;

  function configure(values = {}) {
    for (const key of Object.keys(tune)) {
      if (values[key] === undefined) continue;
      tune[key] = key === 'hint' ? String(values[key]) : Math.max(0, Number(values[key]) || 0);
    }
    try { master.contentHint = tune.hint; } catch {}
    for (const track of clones) { try { if (hintAccessor) hintAccessor.set.call(track, tune.hint); else track.contentHint = tune.hint; } catch {} } // not a write by Meet
    dirty = true;
    return { ...tune };
  }
  function health() {
    return {
      frames,
      fps: frameTimes.length,
      slide: target?.slide ?? null,
      view: target?.view ?? null,
      slides: deck.slides.length,
      moving: motion.kind !== 'none' && progress(performance.now()) < 1,
      lastChangeAt,
      settledAt,
      displayRequests,
      lastConstraints,
      constraintLog: constraintLog.slice(-5),
      hintWrites: hintWrites.slice(-5),
      senderLog: senderLog.slice(-5),
      contentHint: master.contentHint,
      trackSettings: master.getSettings(),
      liveClones: liveCloneCount(),
      sharing,
      instance,
      assets: assets.size,
      decoded: [...assets.values()].filter(entry => entry.bitmap).length,
      speech: { speaking: speech.speaking, onsetAt: speech.onsetAt, endAt: speech.endAt },
      input: { speaking: input.speaking, onsetAt: input.onsetAt, endAt: input.endAt },
    };
  }
  // End every shared clone the way the browser's own "Stop sharing" bar does: the track stops and fires 'ended',
  // which is how a web app such as Meet learns that the presenter stopped sharing.
  function endShare() {
    let ended = 0;
    for (const track of clones) {
      if (!isLive(track)) continue;
      track.stop(); // the wrapper: records the stop and updates sharing
      try { track.dispatchEvent(new Event('ended')); } catch {}
      ended++;
    }
    event({ type: 'stage-share-ended', clones: ended, at: Date.now() });
    return ended;
  }
  // Test/diagnostic: the current stage frame as a PNG data URL (the pre-encode picture).
  function snapshot(type = 'image/png') { return canvas.toDataURL(type); }
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(frameTimer);
    clearInterval(speechTimer);
    for (const track of clones) track.stop();
    clones.clear();
    master.stop();
    for (const entry of assets.values()) { entry.bitmap?.close?.(); entry.fit?.close?.(); }
    assets.clear();
    meetPeers.clear();
    if (navigator.mediaDevices.getDisplayMedia === stageGetDisplayMedia) navigator.mediaDevices.getDisplayMedia = wrapped;
    if (window.RTCPeerConnection === StagePeerConnection) window.RTCPeerConnection = PriorPeerConnection;
    if (RTCRtpSender.prototype.setParameters === stageSetParameters) RTCRtpSender.prototype.setParameters = nativeSetParameters;
  }
  window.RoboMeetStage = { putAsset, hasAssets, setDeck, show, clear, configure, endShare, health, stats, senders, snapshot, close, get track() { return master; } };
})();
