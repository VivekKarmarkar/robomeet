// The robot's REAL briefing: exactly what bin/attend.mjs tells it about itself when it joins a meeting.
//
// buildBriefing() is not exported and reads attend.mjs's own launch variables, so this takes its SOURCE out of
// bin/attend.mjs and evaluates it with the same inputs a launch would give it. A copy would drift the moment attend
// changes; this cannot. Identity tests grade the robot against this text, so it has to be the text it really gets.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as facts from '../../src/briefing-facts.mjs';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

export async function realBriefing({ displayName = 'Vivek Bot', platform = 'Google Meet', agent = 'Claude Code', sessionName = 'robomeet',
  cwd = ROOT, project = 'robomeet', camera = 'on', sharesAtJoin = false, purpose = '', brief = '', recap = '' } = {}) {
  // HONEST_ATTEND_SRC: a snapshot taken when a run started, so a run measures the briefing it began with.
  const source = await readFile(process.env.HONEST_ATTEND_SRC || join(ROOT, 'bin', 'attend.mjs'), 'utf8');
  const start = source.indexOf('function buildBriefing(recap) {');
  if (start < 0) throw new Error('buildBriefing not found in bin/attend.mjs');
  let depth = 0, end = -1;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  const body = source.slice(source.indexOf('{', start) + 1, end - 1);
  const options = { agent, camera, purpose, brief };
  const build = new Function('recap', 'displayName', 'platform', 'options', 'sessionName', 'cwd', 'project', 'sharesAtJoin', 'process', ...Object.keys(facts), body);
  return build(recap, displayName, platform, options, sessionName, cwd, project, sharesAtJoin, process, ...Object.values(facts));
}
