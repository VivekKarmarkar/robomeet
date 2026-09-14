// Injected into the observer's Meet tab: timestamps the fake microphone (test track) and every remote audio track.
(() => {
  const obs = window.__obs = { log: [], wall0: Date.now(), perf0: performance.now() };
  const L = (type, extra = {}) => obs.log.push({ t: performance.now(), type, ...extra });
  L('init', { url: location.href });
  function watch(stream, label) {
    try {
      const ctx = new AudioContext(); const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser(); an.fftSize = 1024; src.connect(an);
      const buf = new Float32Array(an.fftSize); let speaking = false, last = 0, peak = 0;
      setInterval(() => {
        an.getFloatTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        const rms = Math.sqrt(s / buf.length), now = performance.now();
        if (rms > 0.008) { if (!speaking) { speaking = true; peak = 0; L(label + '.onset', { rms: +rms.toFixed(4) }); } last = now; peak = Math.max(peak, rms); }
        else if (speaking && now - last > 350) { speaking = false; L(label + '.offset', { end: last, peak: +peak.toFixed(3) }); }
      }, 10);
      ctx.resume().catch(() => {});
    } catch (e) { L(label + '.watch_error', { message: String(e && e.message) }); }
  }
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  let micWatched = false;
  navigator.mediaDevices.getUserMedia = async c => {
    const s = await gum(c);
    if (c && c.audio && s.getAudioTracks().length) { L('gum.audio', { label: s.getAudioTracks()[0].label }); if (!micWatched) { micWatched = true; watch(s, 'mic'); } }
    return s;
  };
  const NativePC = window.RTCPeerConnection; let n = 0;
  window.RTCPeerConnection = new Proxy(NativePC, { construct(T, args) {
    const pc = Reflect.construct(T, args); const id = ++n; L('pc.created', { id });
    pc.addEventListener('track', e => { if (e.track.kind === 'audio') { const k = obs.log.filter(x => x.type === 'remote.track').length; L('remote.track', { pc: id, k }); watch(e.streams[0] || new MediaStream([e.track]), 'robot' + k); } });
    return pc;
  } });
})();
