// Injected before any page script: timestamps every stage of the voice path on one clock (performance.now()).
(() => {
  const lat = window.__lat = { log: [], stats: [], pcs: [] };
  const L = (type, extra = {}) => lat.log.push({ t: performance.now(), type, ...extra });
  L('init');
  function watch(stream, label) {
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser(); an.fftSize = 1024; src.connect(an);
      const buf = new Float32Array(an.fftSize);
      let speaking = false, last = 0, peak = 0;
      setInterval(() => {
        an.getFloatTimeDomainData(buf);
        let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        const rms = Math.sqrt(s / buf.length), now = performance.now();
        if (rms > 0.008) { if (!speaking) { speaking = true; peak = 0; L(label + '.onset', { rms: +rms.toFixed(4) }); } last = now; peak = Math.max(peak, rms); }
        else if (speaking && now - last > 350) { speaking = false; L(label + '.offset', { end: last, peak: +peak.toFixed(3) }); }
      }, 10);
      ctx.resume().catch(() => {});
      L(label + '.watch', { contextState: ctx.state });
    } catch (e) { L(label + '.watch_error', { message: String(e && e.message) }); }
  }
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async c => { L('gum.request'); const s = await gum(c); L('gum.resolved', { tracks: s.getAudioTracks().map(t => t.label) }); watch(s, 'mic'); return s; };
  const NativePC = window.RTCPeerConnection;
  window.RTCPeerConnection = new Proxy(NativePC, { construct(T, args) {
    const pc = Reflect.construct(T, args); lat.pcs.push(pc); L('pc.created');
    pc.addEventListener('track', e => { L('pc.track', { kind: e.track.kind }); if (e.track.kind === 'audio') watch(e.streams[0] || new MediaStream([e.track]), 'robot'); });
    pc.addEventListener('connectionstatechange', () => L('pc.state', { state: pc.connectionState }));
    pc.addEventListener('iceconnectionstatechange', () => L('pc.ice', { state: pc.iceConnectionState }));
    const cdc = pc.createDataChannel.bind(pc);
    pc.createDataChannel = (...a) => {
      const ch = cdc(...a);
      ch.addEventListener('open', () => L('dc.open'));
      ch.addEventListener('message', ev => { try { const d = JSON.parse(ev.data); const rec = { t: performance.now(), type: 'dc', ev: d.type }; if (typeof d.delta === 'string') rec.delta = d.delta; if (d.start_ms != null) rec.start_ms = d.start_ms; if (d.end_ms != null) rec.end_ms = d.end_ms; if (d.event && d.event.type) rec.inner = d.event.type; if (d.error) rec.error = String(d.error.message || d.error).slice(0, 200); lat.log.push(rec); } catch {} });
      return ch;
    };
    return pc;
  } });
  setInterval(async () => {
    for (const pc of lat.pcs) {
      if (pc.connectionState === 'closed') continue;
      try {
        const sample = { t: performance.now() };
        (await pc.getStats()).forEach(r => {
          if (r.type === 'inbound-rtp' && r.kind === 'audio') Object.assign(sample, { inPackets: r.packetsReceived, inEnergy: r.totalAudioEnergy, jbDelay: r.jitterBufferDelay, jbEmitted: r.jitterBufferEmittedCount, jbTarget: r.jitterBufferTargetDelay, jbMin: r.jitterBufferMinimumDelay, concealed: r.concealedSamples, samples: r.totalSamplesReceived, jitter: r.jitter });
          if (r.type === 'outbound-rtp' && r.kind === 'audio') Object.assign(sample, { outPackets: r.packetsSent, outEnergy: r.totalAudioEnergy });
          if (r.type === 'candidate-pair' && (r.nominated || r.selected) && r.state === 'succeeded') Object.assign(sample, { rtt: r.currentRoundTripTime, rttAvg: r.totalRoundTripTime / Math.max(1, r.responsesReceived) });
          if (r.type === 'media-source' && r.kind === 'audio') sample.micLevel = r.audioLevel;
        });
        lat.stats.push(sample);
      } catch {}
    }
  }, 500);
})();
