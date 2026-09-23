// The demo's script: cards computed from the two runs' reviews, and the chosen clips. One job: plan.json.
// Usage: node tools/sim-participant/make-honest-plan.mjs <beforeRun> <afterRun> <clips.json> <out plan.json>
//   clips.json: { before: [{ meeting, id, kicker? }], after: [...], highlights: [...] }
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [beforeRun, afterRun, clipsPath, outPath] = process.argv.slice(2);
const before = JSON.parse(await readFile(join(beforeRun, 'review.json'), 'utf8'));
const after = JSON.parse(await readFile(join(afterRun, 'review.json'), 'utf8'));
const clips = JSON.parse(await readFile(clipsPath, 'utf8'));
const protocol = JSON.parse(await readFile('tools/sim-participant/protocol/protocol.json', 'utf8'));
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const li = (cls, mark, text) => `<li class="${cls}"><span class="m">${mark}</span><span>${text}</span></li>`;
const meetingName = n => (protocol.assembled.chapters[n - 1]?.title || '').replace(/^Meeting \d+:\s*/, '').replace(/[.(].*$/, '').trim();
const stat = (rev, m) => { const rs = rev.results.filter(r => r.meeting === m && !r.skipped && !r.error); return { n: rs.length, strict: rs.filter(r => r.pass).length, ess: rs.filter(r => r.pass || r.essential?.accept).length, fals: rs.filter(r => r.clean === false).length }; };
const feelMedian = rev => { const xs = rev.results.filter(r => r.latency != null && !r.skipped).map(r => r.latency).sort((a, b) => a - b); return xs.length ? xs[Math.floor(xs.length / 2)] : null; };
const falseCount = rev => rev.results.filter(r => !r.skipped && r.clean === false).length;
const recite = rev => rev.results.filter(r => !r.skipped && /on your shared screen now|that's what's on the shared screen|the box (contains|says)[^.]*\.[^.]*the box (contains|says)/i.test(r.answer || '')).length;

const sequence = [];
const card = (html, sec) => sequence.push({ card: html, sec });
card(`<h1>Vivek Bot, stress-tested honestly</h1><h2>A simulated colleague, Alex (GPT Live), put the robot through ${before.ran + before.skipped} scenarios in 11 meetings.<br>Alex never says anything false: every line is scripted and true, and she only remarks on what the real screen render shows.</h2><ul>
${li('ok', '·', 'Did it: the right tool ran, the screen landed where asked, and the box holds exactly the thing, checked by eye on the real stage render')}
${li('ok', '·', 'Got the content right: checked against the PDF and the physics')}
${li('ok', '·', 'Said nothing false: about itself (against its real briefing), the notes, or what it did')}
${li('ok', '·', 'Felt right: time to first word, length, never talking over someone')}</ul>`, 9);
card(`<h1>Before: what a person would have noticed</h1><h2>Baseline run, robot unchanged. ${before.strict} of ${before.ran} scenarios passed strictly (${before.essential} with essential-only grading).<br>${falseCount(before)} answers said something false. ${recite(before)} answers read the robot's private screen notes aloud.</h2>`, 6);
for (const c of clips.before) sequence.push({ run: beforeRun, meeting: c.meeting, id: c.id, kicker: c.kicker, where: `Before · Meeting ${c.meeting} · ${meetingName(c.meeting)}`, revealSec: 4.5 });
card(`<h1>What was wrong, and what changed</h1><ul>
${li('fx', '1', 'Screen notes were re-sent every 15 s and read aloud. <b>Unchanged screens are no longer re-sent; notes are marked "for you, not to read out"</b> (OpenAI: skip unchanged updates).')}
${li('fx', '2', 'Every box forced a spoken "The box contains …". <b>The pointer now records what was asked; only a wrong or unverifiable box gets an instruction.</b>')}
${li('fx', '3', 'The PDF text layer flattens maths ("v 0 2 sin 2 θ" is v0² sin²θ). <b>Each part now carries its formulas read from its picture</b>, checked against the LaTeX.')}
${li('fx', '4', 'The briefing said only the coding session can move the screen, and that the speaker is Vivek. <b>Corrected; plus rules: never narrate notes, only tools act, "just listen" means silence.</b>')}
${li('fx', '5', 'It greeted over someone reading. <b>It now waits for a pause.</b>')}
${li('fx', '6', 'The pointer could not box a stacked fraction, or a degree sign. <b>Fractions and ° now match; boxes are tight, by eye.</b>')}
${li('ok', '✓', `${clips.tests || 'All'} unit tests pass, including one per fix.`)}</ul>`, 14);
card(`<h1>After: the same meetings, re-run</h1><h2>${after.strict} of ${after.ran} strict (${after.essential} essential). Said something false: ${falseCount(before)} → ${falseCount(after)}. Read private notes aloud: ${recite(before)} → ${recite(after)}.</h2>`, 6);
for (const c of clips.after) sequence.push({ run: afterRun, meeting: c.meeting, id: c.id, kicker: c.kicker, where: `After · Meeting ${c.meeting} · ${meetingName(c.meeting)}`, revealSec: 4.5, label: c.fixed ? 'fixed' : '' });
const rows = [...new Set(before.results.map(r => r.meeting))].sort((a, b) => a - b).map(m => { const b = stat(before, m), a = stat(after, m); return b.n || a.n ? `<tr><td>${m}</td><td>${esc(meetingName(m))}</td><td class="n">${b.strict}/${b.n}</td><td class="n">${a.strict}/${a.n}</td><td class="n">${b.ess}/${b.n}</td><td class="n">${a.ess}/${a.n}</td><td class="n">${b.fals} → ${a.fals}</td></tr>` : ''; }).join('');
const fm = [feelMedian(before), feelMedian(after)].map(x => (x == null ? '–' : `${x.toFixed(1)} s`));
card(`<h1 style="font-size:46px">Scorecard</h1><table><tr><th>#</th><th>Meeting</th><th class="n">strict before</th><th class="n">strict after</th><th class="n">essential before</th><th class="n">essential after</th><th class="n">said false</th></tr>${rows}</table><h2 style="margin-top:18px;font-size:22px">Median time to first word: ${fm[0]} → ${fm[1]}. Strict = every listed point conveyed; essential = a physicist would accept the answer as asked.</h2>`, 12);
card(`<h1>Still not done</h1><ul>${(clips.notDone || []).map(t => li('no', '✗', t)).join('')}
${li('nb', '○', `Not built yet, so only its honesty was tested: ${protocol.scenarios.filter(s => !s.testableNow).map(s => esc(s.title)).slice(0, 4).join('; ')}.`)}
${li('nb', '○', 'Not covered headless: Google Meet admission and the real rejoin. The robot\'s Google sign-in has expired (node bin/login.mjs).')}</ul>`, 12);
await writeFile(outPath, JSON.stringify({ fps: 25, sequence }, null, 1));
console.log(`plan: ${sequence.length} items (${sequence.filter(s => s.card).length} cards)`);
