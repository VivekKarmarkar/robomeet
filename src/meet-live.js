/* RoboMeet single-hop voice overlay for the Google Meet page.
   Integrated 2026-09-14 from work/robomeet-test/latency/single-hop (drafted and fixture-tested by the latency workflow).

   Load order: src/meet-media.js first (unchanged), then this file, both as Playwright init scripts.
   This file owns only the robot's audio leg:
     meeting remote audio tracks -> in-page mix -> GPT Live WebRTC   (offer created here, relayed by Node)
     GPT Live remote audio track -> speak gate -> the fake microphone that Meet captures
   It never modifies meet-media.js. It stacks a second RTCPeerConnection proxy (to collect the meeting's
   remote audio) and a second getUserMedia override (to hand Meet its own microphone track) on top of it.
   Camera and screen video still travel over meet-media's bridge from the renderer. The bridge's audio
   m-line stays negotiated because meet-media.js requires it, but in this mode it carries silence out
   (the renderer never starts voice) and its inbound mix is no longer what Meet captures.

   Secrets: the page never sees the control token or the OpenAI key. Node calls createOffer(), posts the
   SDP to POST /api/live/sessions itself with the local bearer token, then calls accept(id, answerSdp).
   Close order at teardown: RoboMeetLive.close() BEFORE RoboMeetMedia.close(), so each restores the
   globals it replaced in reverse order of installation.
   Meet's CSP sets require-trusted-types-for 'script': this file must never use innerHTML, eval, or
   worklet/worker module URLs. It only uses createElement and Web Audio. */
(() => {
  if (window.RoboMeetLive) return;
  const Proxied = window.RTCPeerConnection;
  // meet-media's proxy has only a construct trap, so `.prototype` falls through to the native constructor
  // and `.prototype.constructor` is the real RTCPeerConnection. Peers built from it bypass both proxies,
  // which is what keeps the model's own voice out of both meeting mixes.
  const NativePeerConnection = Proxied.prototype.constructor;
  const underGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const audio = new AudioContext({ latencyHint: 'interactive' });
  const mix = audio.createMediaStreamDestination();        // meeting -> model
  const inputGain = audio.createGain();
  inputGain.connect(mix);
  const microphone = audio.createMediaStreamDestination(); // model -> meeting
  const outputGain = audio.createGain();
  outputGain.gain.value = 0;
  outputGain.connect(microphone);
  for (const destination of [mix, microphone]) { const keep = audio.createConstantSource(); keep.offset.value = 0; keep.connect(destination); keep.start(); }
  // Meters are pulled through a zero-gain sink (same pattern as meet-media.js); they never produce sound.
  const inputMeter = audio.createAnalyser();
  const outputMeter = audio.createAnalyser();
  inputMeter.fftSize = outputMeter.fftSize = 256;
  const meterSink = audio.createGain();
  meterSink.gain.value = 0;
  inputGain.connect(inputMeter).connect(meterSink);
  outputGain.connect(outputMeter).connect(meterSink);
  meterSink.connect(audio.destination);
  const sources = new Map();
  let session = null;
  let generation = 0;
  let mode = 'listen';
  let closed = false;
  let lastInputAudibleAt = null;
  let lastOutputAudibleAt = null;
  let outputOnsetAt = null; // first audible model audio after >= 300 ms of output silence
  let outputSilentSince = Date.now();
  const event = data => {
    try { Promise.resolve(window.__robomeetLiveEvent?.(data)).catch(() => {}); } catch {}
  };
  const rms = meter => {
    const data = new Float32Array(meter.fftSize);
    meter.getFloatTimeDomainData(data);
    return Math.sqrt(data.reduce((sum, sample) => sum + sample * sample, 0) / data.length);
  };
  // 20 ms poll. Timestamps are wall-clock so Node can line them up with the server's own event times.
  const meterTimer = setInterval(() => {
    const now = Date.now();
    if (rms(inputMeter) > 0.001) lastInputAudibleAt = now;
    if (rms(outputMeter) > 0.001) {
      if (outputSilentSince && now - outputSilentSince >= 300) { outputOnsetAt = now; event({ type: 'live-output-onset', at: now, sessionId: session?.id || null }); }
      outputSilentSince = null;
      lastOutputAudibleAt = now;
    } else if (!outputSilentSince) outputSilentSince = now;
  }, 20);

  function applyGains() {
    const now = audio.currentTime;
    outputGain.gain.setValueAtTime(session && mode === 'speak' ? 1 : 0, now);
    inputGain.gain.setValueAtTime(mode === 'quiet' ? 0 : 1, now);
  }
  function removeInput(track) {
    const entry = sources.get(track);
    if (!entry) return;
    entry.node.disconnect();
    entry.playback.pause();
    entry.playback.srcObject = null;
    sources.delete(track);
    event({ type: 'live-input-tracks', count: sources.size });
  }
  function addInput(track, peer) {
    if (closed || track.kind !== 'audio' || sources.has(track)) return;
    const node = audio.createMediaStreamSource(new MediaStream([track]));
    // Same reason as meet-media.js: Chromium keeps a remote track decoding only with a media-element consumer.
    const playback = document.createElement('audio');
    playback.muted = true;
    playback.srcObject = new MediaStream([track]);
    playback.play().catch(() => {});
    node.connect(inputGain);
    sources.set(track, { node, peer, playback });
    track.addEventListener('ended', () => removeInput(track), { once: true });
    audio.resume().catch(() => {});
    event({ type: 'live-input-tracks', count: sources.size });
  }
  // Meet's peers pass through this proxy and then meet-media's. The GPT Live peer below is built from
  // NativePeerConnection, so its remote track (the model's voice) never enters either mix.
  window.RTCPeerConnection = new Proxy(Proxied, {
    construct(Target, args) {
      const peer = Reflect.construct(Target, args);
      peer.addEventListener('track', ({ track }) => addInput(track, peer));
      peer.addEventListener('connectionstatechange', () => {
        if (peer.connectionState === 'closed' || peer.connectionState === 'failed') {
          for (const [track, source] of sources) if (source.peer === peer) removeInput(track);
        }
      });
      return peer;
    },
  });
  // Audio: this overlay's microphone. Video: whatever meet-media.js (or the browser) provides.
  navigator.mediaDevices.getUserMedia = async constraints => {
    if (closed) throw new DOMException('Single-hop voice overlay is closed', 'InvalidStateError');
    if (!constraints?.audio) return underGetUserMedia(constraints);
    const tracks = [microphone.stream.getAudioTracks()[0].clone()];
    if (constraints.video) tracks.push(...(await underGetUserMedia({ video: constraints.video })).getVideoTracks());
    await audio.resume();
    return new MediaStream(tracks);
  };

  function waitForIce(peer, timeoutMs) {
    return new Promise(resolve => {
      if (peer.iceGatheringState === 'complete') return resolve();
      const timer = setTimeout(done, timeoutMs);
      function done() { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', check); resolve(); }
      function check() { if (peer.iceGatheringState === 'complete') done(); }
      peer.addEventListener('icegatheringstatechange', check);
    });
  }
  function detachModel(current) {
    current.remoteSource?.disconnect();
    current.remoteSource = null;
    if (current.playback) { current.playback.pause(); current.playback.srcObject = null; }
    current.playback = null;
  }
  // Step 1 of session start: build the GPT Live peer and return the complete SDP offer (host candidates
  // gathered, like public/live.js). Node relays it; nothing here touches the network on its own.
  async function createOffer({ iceTimeoutMs = 1500, jitterTargetMs = 40 } = {}) {
    if (closed) throw new Error('Single-hop voice overlay is closed');
    if (session) throw new Error('A voice session already exists in the meeting page');
    const live = [...sources.keys()].filter(track => track.readyState === 'live').length;
    if (!live) throw new Error('Meeting audio is not connected yet');
    const epoch = ++generation;
    const peer = new NativePeerConnection();
    const current = { peer, epoch, id: null, started: false, channel: null, remoteSource: null, playback: null };
    peer.addTrack(mix.stream.getAudioTracks()[0], mix.stream);
    peer.ontrack = ({ track, streams, receiver }) => {
      if (epoch !== generation || track.kind !== 'audio') return;
      // Same knob public/live.js sets on its GPT Live receiver (default 40 ms there): Chrome's adaptive playout
      // buffer otherwise settles well above what a stable link needs. A target, not a floor.
      try { receiver.jitterBufferTarget = jitterTargetMs; } catch {}
      detachModel(current);
      const stream = streams[0] || new MediaStream([track]);
      current.remoteSource = audio.createMediaStreamSource(stream);
      current.remoteSource.connect(outputGain);
      current.playback = document.createElement('audio');
      current.playback.muted = true;
      current.playback.srcObject = stream;
      current.playback.play().catch(() => {});
      event({ type: 'live-model-track', epoch });
    };
    peer.onconnectionstatechange = () => event({ type: 'live-state', state: peer.connectionState, epoch, sessionId: current.id });
    const channel = peer.createDataChannel('oai-events');
    current.channel = channel;
    channel.onmessage = ({ data }) => {
      let message;
      try { message = JSON.parse(data); } catch { return; }
      if (epoch !== generation) return;
      if (message.type === 'session.started') { current.started = true; event({ type: 'live-started', epoch, sessionId: current.id }); }
      else if (message.type === 'session.closed') event({ type: 'live-upstream-closed', epoch, sessionId: current.id, reason: message.reason || null });
      else if (message.type === 'error') event({ type: 'live-error', epoch, sessionId: current.id, message: String(message.error?.message || message.message || 'Voice service error').slice(0, 300) });
      // Transcripts and tool events are handled by the server's sideband; the page ignores them.
    };
    await peer.setLocalDescription(await peer.createOffer());
    await waitForIce(peer, iceTimeoutMs);
    if (epoch !== generation) { peer.close(); throw new Error('Voice startup was superseded'); }
    session = current;
    applyGains();
    await audio.resume();
    return peer.localDescription.sdp;
  }
  // Step 2: Node hands back the session id and the SDP answer from POST /api/live/sessions.
  async function accept(id, sdp) {
    if (!session) throw new Error('No pending voice offer in the meeting page');
    session.id = String(id);
    await session.peer.setRemoteDescription({ type: 'answer', sdp });
    return health();
  }
  function closeSession(reason = 'requested') {
    if (!session) return null;
    const current = session;
    session = null;
    generation++;
    detachModel(current);
    current.channel?.close();
    current.peer.onconnectionstatechange = null;
    current.peer.ontrack = null;
    current.peer.close();
    applyGains();
    event({ type: 'live-closed', reason, sessionId: current.id });
    return current.id;
  }
  function setMode(next) {
    if (!['quiet', 'listen', 'speak'].includes(next)) return mode;
    mode = next;
    applyGains();
    return mode;
  }
  function health() {
    const live = [...sources.keys()].filter(track => track.readyState === 'live' && !track.muted).length;
    return {
      mode,
      audioContext: audio.state,
      inputTracks: sources.size,
      liveInputTracks: live,
      lastInputAudibleAt,
      lastOutputAudibleAt,
      outputOnsetAt,
      session: session ? {
        id: session.id,
        epoch: session.epoch,
        started: session.started,
        connection: session.peer.connectionState,
        ice: session.peer.iceConnectionState,
        channel: session.channel?.readyState || 'none',
        modelTrack: Boolean(session.remoteSource),
      } : null,
    };
  }
  // Test-only: the worker calls this only under ROBOMEET_TEST_MODE=1. It feeds the microphone directly
  // (bypassing the speak gate) so routing can be checked before any paid session exists.
  async function testTone({ frequency = 440, durationMs = 1000 } = {}) {
    await audio.resume();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.frequency.value = frequency;
    gain.gain.value = 0.08;
    oscillator.connect(gain).connect(microphone);
    oscillator.start();
    oscillator.stop(audio.currentTime + Math.min(10000, Math.max(50, durationMs)) / 1000);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  }
  function close() {
    if (closed) return;
    closed = true;
    closeSession('overlay_closed');
    clearInterval(meterTimer);
    for (const track of sources.keys()) removeInput(track);
    microphone.stream.getTracks().forEach(track => track.stop());
    mix.stream.getTracks().forEach(track => track.stop());
    meterSink.disconnect();
    audio.close().catch(() => {});
    navigator.mediaDevices.getUserMedia = underGetUserMedia;
    window.RTCPeerConnection = Proxied;
  }
  window.RoboMeetLive = { createOffer, accept, closeSession, setMode, health, testTone, close };
})();
