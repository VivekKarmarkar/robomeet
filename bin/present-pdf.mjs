#!/usr/bin/env node
// Present a PDF in the meeting as a scrolling document (the same path as the MCP tool present_pdf): every page becomes
// a slide with fit-to-width views rendered pixel-exact at 1920x1080 (src/deck-builder.mjs), then the server loads it
// with present-deck. Prints what each view shows, so narration can be written against it.
// Usage: node bin/present-pdf.mjs <file.pdf> [--title TITLE] [--max-pages N] [--no-share]
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildPdfDeck, slugFor } from '../src/deck-builder.mjs';
const { values: options, positionals } = parseArgs({ allowPositionals: true, options: { title: { type: 'string' }, 'max-pages': { type: 'string', default: '60' }, 'no-share': { type: 'boolean', default: false } } });
const [pdf] = positionals;
if (!pdf) { console.error('Usage: node bin/present-pdf.mjs <file.pdf> [--title TITLE] [--max-pages N] [--no-share]'); process.exit(1); }
const appDir = fileURLToPath(new URL('..', import.meta.url));
const dataDir = process.env.ROBO_DATA_DIR || join(appDir, 'data');
const base = new URL(process.env.ROBO_URL || 'http://127.0.0.1:4318');
const slug = slugFor(pdf);
const deck = await buildPdfDeck(resolve(pdf), { slidesRoot: join(appDir, 'public', 'slides'), slug, title: options.title, maxPages: Math.min(60, Number(options['max-pages']) || 60) });
const token = (await readFile(join(dataDir, 'control-token'), 'utf8')).trim();
const response = await fetch(new URL('/api/command', base), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'present-deck', slug, ...(options['no-share'] ? {} : { enabled: true }) }) });
const result = await response.json();
if (!response.ok) { console.error(result.error || `HTTP ${response.status}`); process.exit(2); }
console.log(`Presented ${deck.pages} page(s) of ${basename(pdf)} as deck "${slug}" (sharing ${options['no-share'] ? 'unchanged' : 'on'}).`);
for (const [s, slide] of deck.slides.entries()) for (const [v, view] of slide.views.entries()) {
  console.log(`slide ${s} view ${v} (page ${s + 1}, part ${v + 1}/${slide.views.length}): ${(view.lines || []).map(line => typeof line === 'string' ? line : line.text).join(' | ').slice(0, 300)}`);
}
