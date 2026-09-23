// Compare honest-protocol runs on the scenarios they all ran. One job: the numbers, with their definitions.
// Usage: node tools/sim-participant/compare-runs.mjs <out.json> <runDir>...   (each run must have review.json)
//
// Definitions (per scenario; a run's value is the count over the scenarios every listed run ran):
//   strict          the protocol's own grade passed (did, conveyed, clean and felt all true)
//   essential       strict, or the essential re-grade accepted it (review-honest.mjs --essential)
//   did_fail        the "did it" check failed (tool, screen part, box contents or tightness)
//   tool_never_ran  a tool the scenario must run is not among the tools that ran during it
//   content_fail    the judge found a required point missing ("conveyed" false)
//   clean_fail      the judge's clean check failed: said something false, OR broke one of the scenario's must-not
//                   rules (e.g. talked while told to listen, too long, a claim it could not check)
//   feel_fail       any feel note (latency over budget, too many words, talked over Alex, spoke when told to listen)
//   no_reply        feel note "no spoken reply to the first turn"
//   talked_over     the robot overlapped Alex for more than 1.5 s in the first exchange
//   spoke_listening feel note "spoke during the listening window"
//   notes_aloud     the answer matches a text pattern for reading screen notes aloud (see NOTES below)
//   lat50/lat90     time from the end of Alex's first line to the robot's first word, median and 90th percentile
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const NOTES = /on your shared screen now|that's what's on the shared screen|still on the (results|setup)|the box (contains|says)[^.]*\.[^.]*the box (contains|says)|page (one|1), part|part (one|two|three|1|2|3) of (three|3)/i;
const [outPath, ...runs] = process.argv.slice(2);
const protocol = JSON.parse(await readFile(new URL('./protocol/protocol.json', import.meta.url), 'utf8'));
const must = new Map(protocol.scenarios.map(s => [s.id, s.mustTools || []]));
const ok = r => !r.skipped && !r.error;
const data = {};
for (const run of runs) data[run] = JSON.parse(await readFile(join(run, 'review.json'), 'utf8')).results.filter(ok);
const ids = [...new Set(data[runs[0]].map(r => r.id))].filter(id => runs.every(run => data[run].some(r => r.id === id)));
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(p * (s.length - 1))] : null; };
const out = { scenarios: ids.length, runs: {} };
for (const run of runs) {
  const rs = ids.map(id => data[run].find(r => r.id === id));
  const notes = f => (r => (r.feelNotes || []).join(' ').includes(f));
  const lat = rs.map(r => r.latency).filter(x => x != null);
  out.runs[run] = {
    strict: rs.filter(r => r.pass).length,
    essential: rs.filter(r => r.pass || r.essential?.accept).length,
    did_fail: rs.filter(r => r.did === false).length,
    tool_never_ran: rs.filter(r => must.get(r.id).some(t => !(r.tools || []).includes(t))).length,
    content_fail: rs.filter(r => r.conveyed === false).length,
    clean_fail: rs.filter(r => r.clean === false).length,
    feel_fail: rs.filter(r => r.felt === false).length,
    no_reply: rs.filter(notes('no spoken reply')).length,
    talked_over: rs.filter(r => (r.overlap || 0) > 1.5).length,
    spoke_listening: rs.filter(notes('listening window')).length,
    notes_aloud: rs.filter(r => NOTES.test(r.answer || '')).length,
    lat50: q(lat, 0.5), lat90: q(lat, 0.9),
  };
}
// Paired flips between the first and the last run: how many scenarios changed each way.
const [a, b] = [runs[0], runs.at(-1)];
const get = (run, id) => data[run].find(r => r.id === id);
const flips = key => ({ up: ids.filter(id => !key(get(a, id)) && key(get(b, id))).length, down: ids.filter(id => key(get(a, id)) && !key(get(b, id))).length });
out.flips = { strict: flips(r => r.pass), essential: flips(r => r.pass || r.essential?.accept), clean: flips(r => r.clean !== false) };
out.wins = ids.filter(id => !(get(a, id).pass || get(a, id).essential?.accept) && (get(b, id).pass || get(b, id).essential?.accept));
out.losses = ids.filter(id => (get(a, id).pass || get(a, id).essential?.accept) && !(get(b, id).pass || get(b, id).essential?.accept));
await writeFile(outPath, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1).slice(0, 2500));
