#!/usr/bin/env node
// Add clean formula transcriptions to a built deck: node bin/deck-math.mjs <slug> [--print]
// For each view with a rendered picture, src/view-math.mjs reads its displayed formulas; they are stored as the view's
// `math` and sent to the robot with that part's screen text (src/screen-context.mjs). --print shows them and writes
// nothing, so they can be checked against the source before they are kept.
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcribeViewMath } from '../src/view-math.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const slug = process.argv[2];
if (!slug || !/^[a-z0-9][a-z0-9-]{0,80}$/.test(slug)) { console.error('Usage: node bin/deck-math.mjs <slug> [--print]'); process.exit(2); }
const path = join(root, 'public', 'slides', slug, 'deck.json');
const deck = JSON.parse(await readFile(path, 'utf8'));
for (const [s, slide] of (deck.slides || []).entries()) {
  for (const [v, view] of (slide.views || []).entries()) {
    if (!view.asset) continue;
    const png = await readFile(join(root, 'public', view.asset.replace(/^\//, '')));
    view.math = await transcribeViewMath({ png });
    console.log(`slide ${s + 1} part ${v + 1}:`); for (const line of view.math) console.log(`  ${line}`);
  }
}
if (!process.argv.includes('--print')) { await writeFile(path, JSON.stringify(deck, null, 2) + '\n'); console.log(`wrote ${path}`); }
