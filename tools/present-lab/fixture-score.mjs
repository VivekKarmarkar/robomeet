// SSIM / PSNR of a received frame against the ideal 1920x1080 render (received frames are scaled up if smaller).
// ffmpeg prints its ssim/psnr summaries on stderr. Shared by tools/present-lab/live-observer.mjs.
import { spawnSync } from 'node:child_process';
export function score(received, ideal) {
  const run = metric => spawnSync('ffmpeg', ['-hide_banner', '-i', received, '-i', ideal, '-lavfi', `[0:v]scale=1920:1080:flags=bicubic,format=yuv444p[a];[1:v]format=yuv444p[b];[a][b]${metric}`, '-f', 'null', '-'], { encoding: 'utf8' }).stderr || '';
  const ssim = run('ssim');
  const psnr = run('psnr');
  const y = ssim.match(/SSIM Y:([0-9.]+)/);
  const all = ssim.match(/All:([0-9.]+)/);
  const py = psnr.match(/PSNR y:([0-9.]+|inf)/);
  return { ssimY: y ? +(+y[1]).toFixed(4) : null, ssimAll: all ? +(+all[1]).toFixed(4) : null, psnr: py ? py[1] : null };
}
