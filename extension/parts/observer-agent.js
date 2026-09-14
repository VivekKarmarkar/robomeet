// Verification observer: a second participant that measures what the robot sends and can speak a clip.
// It never opens a real camera or microphone: its outgoing media is a canvas and a WebAudio source.
window.__robomeetAgent = (() => {
  const ui = robomeetUi;
  const Native = window.RTCPeerConnection;
  const peers = new Set();
  window.RTCPeerConnection = new Proxy(Native, { construct(Target, args) { const peer = Reflect.construct(Target, args); peers.add(peer); return peer; } });
  let context, microphone, recorder, chunks = [];
  const audio = () => { context ??= new AudioContext(); microphone ??= context.createMediaStreamDestination(); return context; };
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 180;
  const paint = () => { const g = canvas.getContext('2d'); g.fillStyle = '#334155'; g.fillRect(0, 0, 320, 180); g.fillStyle = '#e2e8f0'; g.font = '24px sans-serif'; g.fillText('Observer', 110, 100); };
  paint(); setInterval(paint, 500);
  navigator.mediaDevices.getUserMedia = async constraints => {
    const tracks = [];
    if (constraints?.audio) { audio(); await context.resume(); tracks.push(microphone.stream.getAudioTracks()[0].clone()); }
    if (constraints?.video) tracks.push(canvas.captureStream(5).getVideoTracks()[0]);
    return new MediaStream(tracks);
  };
  async function speak(base64) {
    const c = audio(); await c.resume();
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const buffer = await c.decodeAudioData(bytes.buffer);
    const source = c.createBufferSource(); source.buffer = buffer; source.connect(microphone); source.start();
    return buffer.duration;
  }
  async function stats() {
    const out = { peers: peers.size, audioIn: [], videoIn: [], audioOut: [] };
    for (const peer of peers) {
      if (peer.connectionState === 'closed') continue;
      (await peer.getStats()).forEach(report => {
        if (report.type === 'inbound-rtp' && report.kind === 'audio') out.audioIn.push({ ssrc: report.ssrc, energy: report.totalAudioEnergy || 0, level: report.audioLevel || 0, bytes: report.bytesReceived || 0 });
        if (report.type === 'inbound-rtp' && report.kind === 'video') out.videoIn.push({ ssrc: report.ssrc, framesDecoded: report.framesDecoded || 0, width: report.frameWidth || 0, height: report.frameHeight || 0, bytes: report.bytesReceived || 0 });
        if (report.type === 'media-source' && report.kind === 'audio') out.audioOut.push({ energy: report.totalAudioEnergy || 0, level: report.audioLevel || 0 });
      });
    }
    return out;
  }
  function recordStart() {
    const c = audio(); void c.resume();
    const mix = c.createMediaStreamDestination();
    let receivers = 0;
    for (const peer of peers) for (const receiver of peer.getReceivers()) {
      if (receiver.track?.kind === 'audio' && receiver.track.readyState === 'live') { c.createMediaStreamSource(new MediaStream([receiver.track])).connect(mix); receivers++; }
    }
    chunks = [];
    recorder = new MediaRecorder(mix.stream, { mimeType: 'audio/webm;codecs=opus' });
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.start(1000);
    return receivers;
  }
  async function recordStop() {
    if (!recorder) return '';
    await new Promise(resolve => { recorder.onstop = resolve; recorder.stop(); });
    const bytes = new Uint8Array(await new Blob(chunks, { type: 'audio/webm' }).arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    recorder = null;
    return btoa(binary);
  }
  return { ready: () => true, join: name => ui.join(name), joinTarget: name => ui.joinTarget(name), inertPoint: ui.inertPoint, activation: ui.activation, admitted: ui.admitted, text: ui.text, buttons: ui.buttonLabels, enableInputs: ui.enableInputs, leave: ui.leave, speak, stats, recordStart, recordStop };
})();
