// A readable picture of one region of the stage. window.RoboMeetStage.snapshot() already returns the live canvas as a
// data URL: the real frame, not a reproduction of it, which is the only kind of picture that can catch a render that
// did not happen. This turns that frame into a crop a vision model can actually read.
//
// Why crop instead of sending the whole 1920x1080 frame: OpenAI's own vision guide lists the two failure modes that
// would otherwise bite (https://developers.openai.com/api/docs/guides/images-vision, "Limitations"):
//   "Spatial reasoning: The model struggles with tasks requiring precise spatial localization"
//   "Small text: Enlarge text within the image to improve readability."
// Cropping to the amber box removes the localization task entirely (the answer becomes "read this", not "find the
// box") and enlarging makes the text big. Both failure modes, gone, for the price of an ffmpeg call.
// One job. No network, no model.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const FFMPEG = process.env.ROBOMEET_FFMPEG_PATH || 'ffmpeg';
export const CONTEXT_PAD_PX = 48; // room around the box so "is anything else inside it?" is answerable
export const MIN_CROP_W = 768;    // upscale below this: the guide says to enlarge small text

export function dataUrlToBuffer(dataUrl) {
  const match = /^data:(image\/[a-z+]+);base64,(.+)$/is.exec(String(dataUrl || ''));
  if (!match) return null;
  return { mime: match[1], bytes: Buffer.from(match[2], 'base64') };
}

// Clamp a pixel rectangle to the frame, grown by `pad`, rounded to even numbers (ffmpeg crop wants integers and
// several encoders want even dimensions).
export function cropRect(rect, { width, height, pad = CONTEXT_PAD_PX } = {}) {
  if (!rect || !(width > 0) || !(height > 0)) return null;
  const left = Math.max(0, Math.floor(rect.x - pad));
  const top = Math.max(0, Math.floor(rect.y - pad));
  const right = Math.min(width, Math.ceil(rect.x + rect.w + pad));
  const bottom = Math.min(height, Math.ceil(rect.y + rect.h + pad));
  const w = Math.max(2, (right - left) & ~1), h = Math.max(2, (bottom - top) & ~1);
  if (w <= 0 || h <= 0 || left >= width || top >= height) return null;
  return { x: left, y: top, w: Math.min(w, width - left) & ~1 || 2, h: Math.min(h, height - top) & ~1 || 2 };
}

// PNG bytes of one region, upscaled so its text is legible. `rect` is in frame pixels; omit it for the whole frame.
export async function cropImage(bytes, rect, { minWidth = MIN_CROP_W, frame = null, pad = CONTEXT_PAD_PX } = {}) {
  const size = frame || pngSizeOf(bytes);
  const box = rect && size ? cropRect(rect, { ...size, pad }) : null;
  const filters = [];
  if (box) filters.push(`crop=${box.w}:${box.h}:${box.x}:${box.y}`);
  const scale = box && box.w < minWidth ? Math.min(4, Math.max(1, Math.round((minWidth / box.w) * 10) / 10)) : 1;
  if (scale > 1) filters.push(`scale=iw*${scale}:ih*${scale}:flags=lanczos`);
  const dir = await mkdtemp(join(tmpdir(), 'robomeet-shot-'));
  try {
    const input = join(dir, 'frame.png'), output = join(dir, 'crop.png');
    await writeFile(input, bytes);
    const args = ['-loglevel', 'error', '-y', '-i', input];
    if (filters.length) args.push('-vf', filters.join(','));
    args.push(output);
    await run(FFMPEG, args, { maxBuffer: 64 << 20 });
    return { bytes: await readFile(output), box, scale, mime: 'image/png' };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export function pngSizeOf(bytes) {
  const view = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (view.length < 24 || view.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
}
