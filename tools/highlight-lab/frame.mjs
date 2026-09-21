// A faithful stage frame with the amber box drawn on it, for offline testing.
// Reproduces src/meet-stage.js drawHighlight: pad 14, fill rgba(251,188,4,0.10), stroke #f9ab00, lineWidth 6.
// Used by the adversarial suite so a vision model can be asked what it sees without launching a meeting. The live
// path captures the real canvas with window.RoboMeetStage.snapshot(); this is the bench equivalent of that frame.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const FFMPEG = process.env.ROBOMEET_FFMPEG_PATH || 'ffmpeg';

// `painted` is the box in canvas pixels (src/drawn-box.mjs paintedPixels), already including the stage's own pad.
export async function frameWithBox(assetPath, painted, outPath) {
  const x = Math.round(painted.x), y = Math.round(painted.y), w = Math.round(painted.w), h = Math.round(painted.h);
  const filters = [
    `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=0xFBBC04@0.10:t=fill`, // the 10% amber wash: rgba(251,188,4,0.10)
    `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=0xF9AB00@1.0:t=6`,     // the 6px amber stroke: #f9ab00
  ];
  await run(FFMPEG, ['-loglevel', 'error', '-y', '-i', assetPath, '-vf', filters.join(','), outPath], { maxBuffer: 64 << 20 });
  return outPath;
}
