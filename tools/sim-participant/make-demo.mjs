// Assemble the demo: framing panels, the recorded meeting, the graded results, and what the video does not show.
// Usage: node tools/sim-participant/make-demo.mjs <runDir> <room.mp4> <out.mp4>
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { renderPanels } from '../highlight-lab/panels.mjs';

const run = promisify(execFile);
const [runDir, roomVideo, out] = process.argv.slice(2).map(p => resolve(p)); // absolute: ffmpeg concat resolves list entries against the list's own directory
const report = JSON.parse(await readFile(join(runDir, 'report.json'), 'utf8'));
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const results = report.results || [];
const pass = results.filter(r => r.pass).length;
const work = join(runDir, 'demo'); await mkdir(work, { recursive: true });

const panels = [
  { seconds: 6, html: `<div class="kicker">RoboMeet · simulated participant</div>
    <h1>The robot, tested by<br>another voice. No human.</h1>
    <div class="sub">Alex is a second GPT Live voice with a cartoon face. She talks to the robot, argues with it, and every answer is graded.</div>` },
  { seconds: 8, html: `<div class="kicker">Why a second GPT Live, not text-to-speech</div>
    <h2>The robot could not tell when a fake voice had stopped talking.</h2>
    <div class="sub">My earlier harness spoke with synthetic speech followed by digital silence. The robot's full-duplex model often missed the end of the question, so the same test scored 7 of 8 on one run and 3 of 8 on the next.</div>
    <div class="sub">A second GPT Live is a real full-duplex speaker. In a first probe the two voices took eight clean turns in 36 seconds, overlapping for 0.8 s.</div>` },
  { seconds: 9, html: `<div class="kicker">What you are about to see</div>
    <table>
      <tr><td><b>Vivek Bot</b></td><td>the robot exactly as shipped: its real voice config, real tools, real screen feed</td></tr>
      <tr><td><b>Alex</b></td><td>a GPT Live physicist, steered one step at a time by private stage directions</td></tr>
      <tr><td><b>The screen</b></td><td>the robot's real shared screen, including the box it draws</td></tr>
      <tr><td><b>The faces</b></td><td>each one analyses its own voice as it plays: the mouth follows the sound</td></tr>
      <tr><td><b>The checklist</b></td><td>every answer graded against the robot's real screen state at that moment</td></tr>
    </table>
    <div class="sub" style="font-size:25px;margin-top:14px">Long silences while a tool runs are shortened; nothing anyone said is re-timed.</div>` },
];
const tail = [
  { seconds: 12, html: `<div class="kicker">Results · ${pass} of ${results.length} steps passed</div>
    <table style="font-size:25px">
      <tr><th></th><th>step</th><th>honest</th><th>did it</th></tr>
      ${results.map(r => `<tr><td class="n ${r.pass ? 'good' : 'bad'}" style="font-size:26px">${r.pass ? '✓' : '✗'}</td><td>${esc(r.why)}${r.firstVerdict ? ' *' : ''}</td><td>${r.honest === false ? '<span class="bad">no</span>' : 'yes'}</td><td>${r.did === false ? '<span class="bad">no</span>' : 'yes'}</td></tr>`).join('')}
    </table>
    ${results.some(r => r.firstVerdict) ? `<div class="sub" style="font-size:22px;margin-top:12px">* First graded a fail. The grader was told the scroll tool ran and still wrote that it had not. Re-graded with that fact stated in the truth itself; the robot's answer is unchanged. First grading: ${results.length - 1} of ${results.length}.</div>` : ''}` },
  { seconds: 10, html: `<div class="kicker">What this video does not show, yet</div>
    <h2>This conversation did not go through Google Meet.</h2>
    <div class="sub">The robot's Google sign-in has expired, so it cannot join any Meet right now. The two voices talked over a direct audio link instead, and the room is a meeting-style page.</div>
    <div class="sub">The pieces for the real Meet are built but have never run there: the face on each camera, Alex joining as a second participant, and an orchestrator that runs this same test inside Meet and keeps its audio and graded report.</div>
    <div class="sub">Still unknown until then: whether Meet accepts Alex as a second device on the robot's own account, and how the faces hold up after Meet's own video delay.</div>` },
];

const segs = [];
const still = async (file, seconds, name) => {
  const o = join(work, `${name}.mp4`);
  await run('ffmpeg', ['-loglevel', 'error', '-y', '-loop', '1', '-t', String(seconds), '-i', file, '-f', 'lavfi', '-t', String(seconds), '-i', 'anullsrc=r=48000:cl=stereo',
    '-vf', 'scale=1920:1080,fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-shortest', o]);
  return o;
};
// renderPanels names its files panel-00.png onward on every call, so each batch is encoded before the next renders.
for (const [i, f] of (await renderPanels(panels, work)).entries()) segs.push(await still(f.file, f.seconds, `head-${i}`));
const room = join(work, 'room.mp4');
await run('ffmpeg', ['-loglevel', 'error', '-y', '-i', roomVideo, '-vf', 'scale=1920:1080,fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '160k', room]);
segs.push(room);
for (const [i, f] of (await renderPanels(tail, work)).entries()) segs.push(await still(f.file, f.seconds, `end-${i}`));
await writeFile(join(work, 'list.txt'), segs.map(s => `file '${s}'`).join('\n'));
await run('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(work, 'list.txt'), '-c', 'copy', out]);
const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size', '-of', 'default=nw=1', out]);
console.log(stdout.trim(), '\nwrote', out);
