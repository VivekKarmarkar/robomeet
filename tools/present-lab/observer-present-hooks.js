// Injected into the observer's Meet tab (tools/present-lab/live-observer.mjs): records every received video track
// frame by frame (a 48x27 luminance signature per frame, timestamped with Date.now()), the robot's audio onsets and
// offsets, and exposes inbound-rtp stats, so presentation latency, resolution and narration sync are measured from
// the audience's side.
(() => {
  if (window.top !== window || window.__pobs) return;
  const obs = window.__pobs = { log: [], tracks: [], audio: [] };
  const L = (type, extra = {}) => obs.log.push({ at: Date.now(), type, ...extra });
  const peers = [];
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = new Proxy(Native, { construct(Target, args) {
    const peer = Reflect.construct(Target, args);
    peers.push(peer);
    peer.addEventListener('track', event => { try { onTrack(event.track); } catch (error) { L('hook.error', { message: String(error.message) }); } });
    return peer;
  } });
  function watchAudio(track) {
    const context = new AudioContext();
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const analyser = context.createAnalyser(); analyser.fftSize = 1024; source.connect(analyser);
    const keep = document.createElement('audio'); keep.muted = true; keep.srcObject = new MediaStream([track]); keep.play().catch(() => {});
    const buffer = new Float32Array(analyser.fftSize);
    let speaking = false, last = 0;
    setInterval(() => {
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0; for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
      const rms = Math.sqrt(sum / buffer.length), now = Date.now();
      if (rms > 0.008) { if (!speaking) { speaking = true; obs.audio.push({ phase: 'onset', at: now, track: track.id }); } last = now; }
      else if (speaking && now - last > 450) { speaking = false; obs.audio.push({ phase: 'offset', at: last, track: track.id }); }
    }, 10);
    context.resume().catch(() => {});
  }
  function onTrack(track) {
    if (track.kind === 'audio') { watchAudio(track); L('audio.track', { id: track.id }); return; }
    const video = document.createElement('video');
    video.muted = true; video.autoplay = true; video.playsInline = true;
    video.srcObject = new MediaStream([track]);
    video.style.cssText = 'position:fixed;left:-4000px;top:0;width:320px;height:180px;pointer-events:none';
    document.documentElement.appendChild(video);
    video.play().catch(() => {});
    const probe = document.createElement('canvas'); probe.width = 48; probe.height = 27;
    const pctx = probe.getContext('2d', { willReadFrequently: true });
    const entry = { id: track.id, video, frames: [], endedAt: null };
    obs.tracks.push(entry);
    track.addEventListener('ended', () => { entry.endedAt = Date.now(); L('video.ended', { id: track.id }); });
    const onFrame = (_now, meta) => {
      try {
        pctx.drawImage(video, 0, 0, 48, 27);
        const data = pctx.getImageData(0, 0, 48, 27).data;
        const sig = new Uint8Array(48 * 27);
        for (let i = 0; i < sig.length; i++) sig[i] = (data[i * 4] * 0.3 + data[i * 4 + 1] * 0.59 + data[i * 4 + 2] * 0.11) | 0;
        entry.frames.push({ at: Date.now(), w: meta.width, h: meta.height, sig });
        if (entry.frames.length > 4000) entry.frames.splice(0, 1000);
      } catch {}
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
    L('video.track', { id: track.id });
  }
  // A microphone the harness can speak into at an exact moment (Meet gets this stream instead of the fake device).
  const micContext = new AudioContext();
  const micDestination = micContext.createMediaStreamDestination();
  const micKeep = micContext.createConstantSource(); micKeep.offset.value = 0; micKeep.connect(micDestination); micKeep.start();
  const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async constraints => {
    const tracks = [];
    if (constraints?.audio) { await micContext.resume().catch(() => {}); tracks.push(micDestination.stream.getAudioTracks()[0].clone()); }
    if (constraints?.video) tracks.push(...(await nativeGetUserMedia({ video: constraints.video })).getVideoTracks());
    L('gum', { audio: Boolean(constraints?.audio), video: Boolean(constraints?.video) });
    return new MediaStream(tracks);
  };
  const diff = (a, b) => { let sum = 0; for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]); return sum / a.length; };
  window.__pobsApi = {
    // Play a WAV (given as a byte array) into the microphone Meet is sending; resolves with its start and end times.
    async say(bytes) {
      await micContext.resume().catch(() => {});
      const buffer = await micContext.decodeAudioData(new Uint8Array(bytes).buffer);
      const source = micContext.createBufferSource(); source.buffer = buffer;
      const gain = micContext.createGain(); gain.gain.value = 1.0;
      source.connect(gain).connect(micDestination);
      const startAt = Date.now(); source.start();
      L('say', { ms: Math.round(buffer.duration * 1000) });
      await new Promise(resolve => { source.onended = resolve; });
      return { startAt, endAt: Date.now() };
    },
    async stats() {
      const out = [];
      for (const peer of peers) {
        if (peer.connectionState === 'closed') continue;
        let reports; try { reports = await peer.getStats(); } catch { continue; }
        const codecs = new Map();
        for (const report of reports.values()) if (report.type === 'codec') codecs.set(report.id, report.mimeType);
        for (const report of reports.values()) {
          if (report.type !== 'inbound-rtp' || report.kind !== 'video') continue;
          out.push({ trackIdentifier: report.trackIdentifier, mid: report.mid, frameWidth: report.frameWidth, frameHeight: report.frameHeight, framesPerSecond: report.framesPerSecond, framesDecoded: report.framesDecoded, contentType: report.contentType, freezeCount: report.freezeCount, bytesReceived: report.bytesReceived, codec: codecs.get(report.codecId), decoderImplementation: report.decoderImplementation });
        }
      }
      return out;
    },
    // The presentation: the inbound track marked screenshare, else the widest recently active video.
    async screenTrackId() {
      const stats = await this.stats();
      const marked = stats.filter(item => item.contentType === 'screenshare' && item.framesDecoded > 0).sort((a, b) => (b.frameWidth || 0) - (a.frameWidth || 0));
      if (marked[0]) return { id: marked[0].trackIdentifier, how: 'contentType', stat: marked[0] };
      const now = Date.now();
      const active = obs.tracks.filter(entry => entry.frames.length && now - entry.frames.at(-1).at < 1500).sort((a, b) => (b.frames.at(-1).w || 0) - (a.frames.at(-1).w || 0));
      return active[0] ? { id: active[0].id, how: 'widest', stat: stats.find(item => item.trackIdentifier === active[0].id) || null } : null;
    },
    grab(id) {
      const entry = obs.tracks.find(item => item.id === id);
      if (!entry || !entry.video.videoWidth) return null;
      const canvas = document.createElement('canvas');
      canvas.width = entry.video.videoWidth; canvas.height = entry.video.videoHeight;
      canvas.getContext('2d').drawImage(entry.video, 0, 0);
      return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
    },
    // First frame after `since` that differs from the last frame before it; frames in the following second; settle.
    change(id, since, threshold = 2) {
      const entry = obs.tracks.find(item => item.id === id);
      if (!entry) return { error: 'no such track' };
      const frames = entry.frames;
      const before = [...frames].reverse().find(frame => frame.at <= since);
      const after = frames.filter(frame => frame.at > since);
      const first = before ? after.find(frame => diff(frame.sig, before.sig) > threshold) : after[0];
      let settled = null;
      for (let i = after.length - 1; i > 0; i--) { if (diff(after[i].sig, after[i - 1].sig) > 0.5) { settled = after[i].at - since; break; } }
      return { firstChangeMs: first ? first.at - since : null, framesFirstSecond: first ? after.filter(frame => frame.at >= first.at && frame.at < first.at + 1000).length : 0, settledMs: settled, frames: after.length, size: after.at(-1) ? `${after.at(-1).w}x${after.at(-1).h}` : null };
    },
    lastFrameAt(id) { const entry = obs.tracks.find(item => item.id === id); return entry?.frames.at(-1)?.at || null; },
    // Time the screen content changed between `from` and `to` (for narration sync): frames whose signature jumps.
    changesBetween(id, from, to, threshold = 2) {
      const entry = obs.tracks.find(item => item.id === id);
      if (!entry) return [];
      const out = [];
      const frames = entry.frames.filter(frame => frame.at >= from - 2000 && frame.at <= to);
      for (let i = 1; i < frames.length; i++) if (frames[i].at >= from && diff(frames[i].sig, frames[i - 1].sig) > threshold) out.push(frames[i].at);
      return out;
    },
  };
})();
