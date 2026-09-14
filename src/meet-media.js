/* RoboMeet's meeting-page media adapter. Written independently of Attendee. */
(() => {
  if (window.RoboMeetMedia) return;
  const NativePeerConnection = window.RTCPeerConnection;
  const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const nativeGetDisplayMedia = navigator.mediaDevices.getDisplayMedia?.bind(navigator.mediaDevices);
  const audio = new AudioContext();
  const inputMix = audio.createMediaStreamDestination();
  const microphone = audio.createMediaStreamDestination();
  // Silent keep-alive so neither outgoing destination ever starves its WebRTC sender (see public/media.js).
  for (const destination of [inputMix, microphone]) { const keep = audio.createConstantSource(); keep.offset.value = 0; keep.connect(destination); keep.start(); }
  const inputMeter = audio.createAnalyser();
  inputMeter.fftSize = 256;
  // Keep the input meter processing even before a consumer subscribes to the mix.
  // The zero-gain sink produces no audible output and is never a capture source.
  const meterSink = audio.createGain();
  meterSink.gain.value = 0;
  inputMeter.connect(meterSink).connect(audio.destination);
  const sources = new Map();
  const meetingPeers = new Set();
  let outputAudioSource;
  let outputAudioPlayback;
  let bridge;
  let bridgeEpoch = 0;
  let candidates = [];
  let closed = false;
  let lastAudibleAt = null;
  const event = data => {
    try { Promise.resolve(window.__robomeetMediaEvent?.(data)).catch(() => {}); } catch {}
  };

  function canvasOutput(label) {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const painter = canvas.getContext('2d', { alpha: false });
    const video = document.createElement('video');
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    let frames = 0;
    function paint() {
      painter.fillStyle = '#111827';
      painter.fillRect(0, 0, canvas.width, canvas.height);
      if (video.readyState >= 2 && video.videoWidth) {
        painter.drawImage(video, 0, 0, canvas.width, canvas.height);
        frames++;
      } else {
        painter.fillStyle = '#e2e8f0';
        painter.font = '40px sans-serif';
        painter.textAlign = 'center';
        painter.fillText(label, 640, 360);
      }
    }
    paint();
    const track = canvas.captureStream(30).getVideoTracks()[0];
    const timer = setInterval(paint, 34);
    return {
      track,
      get frames() { return frames; },
      async setTrack(incoming) {
        video.srcObject = new MediaStream([incoming]);
        await video.play();
      },
      clear() { video.pause(); video.srcObject = null; },
      close() { clearInterval(timer); video.pause(); video.srcObject = null; track.stop(); },
    };
  }
  const camera = canvasOutput('RoboMeet AI');
  const screen = canvasOutput('RoboMeet presentation');

  function removeInput(track) {
    const entry = sources.get(track);
    if (!entry) return;
    entry.node.disconnect();
    entry.playback.pause();
    entry.playback.srcObject = null;
    sources.delete(track);
    event({ type: 'meeting-input-tracks', count: sources.size });
  }
  function addInput(track, peer) {
    if (closed || track.kind !== 'audio' || sources.has(track)) return;
    const node = audio.createMediaStreamSource(new MediaStream([track]));
    // Chromium needs a media-element consumer to keep some remote audio tracks
    // decoding. It is muted: this must never play meeting audio into an OS loop.
    const playback = document.createElement('audio');
    playback.muted = true;
    playback.srcObject = new MediaStream([track]);
    playback.play().catch(() => {});
    node.connect(inputMix);
    node.connect(inputMeter);
    sources.set(track, { node, peer, playback });
    track.addEventListener('ended', () => removeInput(track), { once: true });
    audio.resume().catch(() => {});
    event({ type: 'meeting-input-tracks', count: sources.size });
  }
  // Only peers constructed by Meet pass through this proxy. The bridge below
  // deliberately uses NativePeerConnection, so model speech cannot re-enter inputMix.
  window.RTCPeerConnection = new Proxy(NativePeerConnection, {
    construct(Target, args) {
      const peer = Reflect.construct(Target, args);
      meetingPeers.add(peer);
      peer.addEventListener('track', ({ track }) => addInput(track, peer));
      peer.addEventListener('connectionstatechange', () => {
        if (peer.connectionState === 'closed' || peer.connectionState === 'failed') {
          for (const [track, source] of sources) if (source.peer === peer) removeInput(track);
          meetingPeers.delete(peer);
        }
      });
      return peer;
    },
  });

  navigator.mediaDevices.getUserMedia = async constraints => {
    if (closed) throw new DOMException('Meeting media adapter is closed', 'InvalidStateError');
    const tracks = [];
    if (constraints?.audio) tracks.push(microphone.stream.getAudioTracks()[0].clone());
    if (constraints?.video) tracks.push(camera.track.clone());
    if (!tracks.length) return nativeGetUserMedia(constraints);
    await audio.resume();
    return new MediaStream(tracks);
  };
  navigator.mediaDevices.getDisplayMedia = async constraints => {
    if (closed) throw new DOMException('Meeting media adapter is closed', 'InvalidStateError');
    if (constraints?.video === false) throw new TypeError('Screen sharing requires video');
    const track = screen.track.clone();
    const settings = track.getSettings.bind(track);
    track.getSettings = () => ({ ...settings(), displaySurface: 'browser', logicalSurface: true });
    return new MediaStream([track]);
  };

  function disconnectBridge() {
    if (bridge) {
      bridge.onicecandidate = null;
      bridge.onconnectionstatechange = null;
      bridge.close();
      bridge = null;
    }
    outputAudioSource?.disconnect();
    outputAudioSource = null;
    if (outputAudioPlayback) { outputAudioPlayback.pause(); outputAudioPlayback.srcObject = null; }
    outputAudioPlayback = null;
    camera.clear();
    screen.clear();
  }

  async function answer({ description, roles, epoch }) {
    disconnectBridge();
    bridgeEpoch = epoch;
    candidates = candidates.filter(item => item.epoch === epoch);
    const peer = new NativePeerConnection({ iceServers: [] });
    bridge = peer;
    peer.onicecandidate = ({ candidate }) => {
      if (candidate) window.__robomeetSignal?.({ epoch, candidate: candidate.toJSON() }).catch(() => {});
    };
    peer.onconnectionstatechange = () => event({ type: 'bridge-state', state: peer.connectionState, epoch });
    peer.ontrack = ({ track, transceiver }) => {
      const role = Object.keys(roles).find(key => roles[key] === transceiver.mid);
      if (role === 'audio' && track.kind === 'audio') {
        try { transceiver.receiver.jitterBufferTarget = 10; } catch {} // loopback link: keep the playout buffer minimal
        outputAudioSource?.disconnect();
        outputAudioSource = audio.createMediaStreamSource(new MediaStream([track]));
        outputAudioSource.connect(microphone);
        outputAudioPlayback = document.createElement('audio');
        outputAudioPlayback.muted = true;
        outputAudioPlayback.srcObject = new MediaStream([track]);
        outputAudioPlayback.play().catch(() => {});
      } else if ((role === 'camera' || role === 'screen') && track.kind === 'video') {
        (role === 'camera' ? camera : screen).setTrack(track).catch(error => event({ type: 'media-error', message: error.message }));
      } else {
        event({ type: 'media-error', message: 'Unexpected bridge track role' });
      }
      track.addEventListener('ended', () => event({ type: 'bridge-track-ended', role, epoch }), { once: true });
    };
    await peer.setRemoteDescription(description);
    const audioTransceiver = peer.getTransceivers().find(item => item.mid === roles.audio);
    if (!audioTransceiver) throw new Error('Bridge offer contains no audio transceiver');
    await audioTransceiver.sender.replaceTrack(inputMix.stream.getAudioTracks()[0]);
    audioTransceiver.direction = 'sendrecv';
    for (const item of candidates.splice(0)) await peer.addIceCandidate(item.candidate);
    await peer.setLocalDescription(await peer.createAnswer());
    await audio.resume();
    return peer.localDescription.toJSON();
  }

  async function addCandidate(item) {
    if (item.epoch < bridgeEpoch) return;
    if (item.epoch !== bridgeEpoch || !bridge?.remoteDescription) {
      candidates.push(item);
      return;
    }
    await bridge.addIceCandidate(item.candidate);
  }

  function health() {
    const data = new Float32Array(inputMeter.fftSize);
    inputMeter.getFloatTimeDomainData(data);
    const rms = Math.sqrt(data.reduce((sum, sample) => sum + sample * sample, 0) / data.length);
    const live = [...sources.keys()].filter(track => track.readyState === 'live' && !track.muted).length;
    if (live && rms > 0.001) lastAudibleAt = Date.now();
    return {
      input: live === 0 ? 'no-input' : rms > 0.001 ? 'active' : 'silent',
      inputTracks: sources.size,
      liveInputTracks: live,
      inputRms: Math.round(rms * 100000) / 100000,
      lastAudibleAt,
      bridge: bridge?.connectionState || 'not-connected',
      audioContext: audio.state,
      cameraFrames: camera.frames,
      screenFrames: screen.frames,
    };
  }

  async function publicationStats() {
    const reports = [];
    for (const peer of meetingPeers) {
      const streams = [];
      try {
        for (const report of (await peer.getStats()).values()) {
          if (!['inbound-rtp', 'outbound-rtp'].includes(report.type) || report.isRemote) continue;
          const item = { type: report.type, kind: report.kind || report.mediaType };
          for (const key of ['bytesSent', 'bytesReceived', 'packetsSent', 'packetsReceived', 'framesEncoded', 'framesDecoded', 'framesSent', 'framesReceived', 'totalAudioEnergy', 'totalSamplesDuration', 'audioLevel', 'mid']) {
            if (report[key] !== undefined) item[key] = report[key];
          }
          streams.push(item);
        }
        reports.push({ state: peer.connectionState, streams });
      } catch {}
    }
    return reports;
  }

  function close() {
    if (closed) return;
    closed = true;
    disconnectBridge();
    for (const track of sources.keys()) removeInput(track);
    camera.close();
    screen.close();
    microphone.stream.getTracks().forEach(track => track.stop());
    inputMix.stream.getTracks().forEach(track => track.stop());
    inputMeter.disconnect();
    meterSink.disconnect();
    audio.close().catch(() => {});
    navigator.mediaDevices.getUserMedia = nativeGetUserMedia;
    if (nativeGetDisplayMedia) navigator.mediaDevices.getDisplayMedia = nativeGetDisplayMedia;
    window.RTCPeerConnection = NativePeerConnection;
    candidates = [];
  }
  window.RoboMeetMedia = { answer, addCandidate, health, publicationStats, close };
})();
