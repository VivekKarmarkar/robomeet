// Aggregate an honest-protocol run into one report. One job: read every meeting's results and say what failed.
//
// Two numbers, both reported, never merged: STRICT is the protocol's own grade (every listed point conveyed).
// ESSENTIAL re-asks only for answers that did the job, said nothing false and felt right but missed a listed point:
// would a knowledgeable colleague accept the answer to the question as actually asked? It can only turn a
// "missed a point" fail into an essential pass; it never touches did, clean or felt.
//
// Usage: node tools/sim-participant/review-honest.mjs <runDir> [--essential]
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const KEY = process.env.OPENAI_API_KEY;
const runDir = process.argv[2];
const results = [];
for (const d of (await readdir(runDir)).filter(d => /^ch\d+$/.test(d)).sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)))) {
  let rows = null;
  try { rows = JSON.parse(await readFile(join(runDir, d, 'timeline.json'), 'utf8')).results; }
  catch { try { rows = JSON.parse(await readFile(join(runDir, d, 'results.partial.json'), 'utf8')); } catch {} }
  for (const r of rows || []) results.push({ meeting: Number(d.slice(2)), ...r });
}
async function essential(r) {
  const input = `A person in a meeting asked an AI participant a question about projectile-motion notes (no air resistance; R = v0² sin 2θ / g, H = v0² sin²θ / 2g, T = 2 v0 sin θ / g). The answer has already been checked: it says nothing false and it did any action asked. A strict grader failed it only for leaving out some of these listed points: ${r.why}
Asked: "${r.asked}"
Answered: "${r.answer}"
Would a knowledgeable physicist colleague accept this answer as correct and sufficient for the question as it was actually asked, in a live conversation? Reply ACCEPT or REJECT, then at most 15 words.`;
  const res = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-sol', input, max_output_tokens: 400 }) });
  if (!res.ok) return null;
  const b = await res.json();
  const text = (b.output || []).flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join(' ').trim();
  return { accept: /^\s*ACCEPT/i.test(text), note: text.replace(/^\s*(ACCEPT|REJECT)\s*:?\s*/i, '').slice(0, 140) };
}
if (process.argv.includes('--essential')) {
  await Promise.all(results.filter(r => !r.skipped && !r.pass && r.did && r.clean && r.felt && r.conveyed === false).map(async r => { r.essential = await essential(r); }));
}
const ran = results.filter(r => !r.skipped && !r.error), skipped = results.filter(r => r.skipped), errors = results.filter(r => r.error);
const strict = ran.filter(r => r.pass).length;
const ess = ran.filter(r => r.pass || r.essential?.accept).length;
const by = key => ran.filter(r => r[key] === false).length;
const lines = [`# Honest protocol: ${runDir}`, '',
  `Scenarios run: ${ran.length} · strict pass: ${strict} · essential pass: ${ess} · skipped: ${skipped.length} · harness errors: ${errors.length}`,
  `Failed on: did it ${by('did')} · content ${by('conveyed')} · said something false ${by('clean')} · feel ${by('felt')}`, ''];
for (const m of [...new Set(results.map(r => r.meeting))]) {
  const rs = results.filter(r => r.meeting === m), rr = rs.filter(r => !r.skipped && !r.error);
  lines.push(`## Meeting ${m}: ${rr.filter(r => r.pass).length}/${rr.length} strict, ${rr.filter(r => r.pass || r.essential?.accept).length}/${rr.length} essential${rs.some(r => r.skipped) ? `, ${rs.filter(r => r.skipped).length} skipped` : ''}`);
  for (const r of rs) {
    if (r.skipped) { lines.push(`- SKIP ${r.id}: ${r.skipped}`); continue; }
    if (r.error) { lines.push(`- ERROR ${r.id}: ${r.error.split('\n')[0]}`); continue; }
    const flags = [r.did ? '' : 'did', r.conveyed ? '' : 'content', r.clean ? '' : 'FALSE', r.felt ? '' : 'feel'].filter(Boolean).join(',');
    lines.push(`- ${r.pass ? 'PASS' : r.essential?.accept ? 'ESS ' : 'FAIL'} ${r.id}${flags ? ` [${flags}]` : ''} ${r.latency != null ? `${r.latency.toFixed(1)}s` : ''} ${r.words}w`);
    if (!r.pass) {
      lines.push(`    asked: ${String(r.asked).slice(0, 260)}`);
      lines.push(`    said : ${String(r.answer).slice(0, 420)}`);
      lines.push(`    why  : ${[...(r.checks || []), r.why, ...(r.feelNotes || [])].filter(x => x && x !== 'ok').join(' | ').slice(0, 300)}${r.essential ? ` || essential: ${r.essential.accept ? 'ACCEPT' : 'REJECT'} ${r.essential.note}` : ''}`);
    }
  }
  lines.push('');
}
await writeFile(join(runDir, 'review.md'), lines.join('\n'));
await writeFile(join(runDir, 'review.json'), JSON.stringify({ ran: ran.length, strict, essential: ess, skipped: skipped.length, errors: errors.length, results }, null, 1));
console.log(lines.slice(0, 4).join('\n'));
