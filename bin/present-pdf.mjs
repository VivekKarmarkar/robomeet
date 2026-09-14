#!/usr/bin/env node
// Present a PDF in the meeting: render its pages to pictures and send them to the robot's slide canvas.
// Usage: node bin/present-pdf.mjs <file.pdf> [--title TITLE] [--max-pages N] [--no-share]
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { renderPdfSlides } from '../src/pdf-slides.mjs';
const { values: options, positionals } = parseArgs({ allowPositionals: true, options: { title: { type: 'string' }, 'max-pages': { type: 'string', default: '400' }, 'no-share': { type: 'boolean', default: false } } });
const [pdf] = positionals;
if (!pdf) { console.error('Usage: node bin/present-pdf.mjs <file.pdf> [--title TITLE] [--max-pages N] [--no-share]'); process.exit(1); }
const appDir = fileURLToPath(new URL('..', import.meta.url));
const dataDir = process.env.ROBO_DATA_DIR || join(appDir, 'data');
const base = new URL(process.env.ROBO_URL || 'http://127.0.0.1:4318');
const { slug, pages, slides } = await renderPdfSlides(pdf, { slidesRoot: join(appDir, 'public', 'slides'), maxPages: Number(options['max-pages']) || 400 });
const token = (await readFile(join(dataDir, 'control-token'), 'utf8')).trim();
const response = await fetch(new URL('/api/command', base), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'present', title: options.title || basename(pdf, '.pdf'), slides, ...(options['no-share'] ? {} : { enabled: true }) }) });
const result = await response.json();
if (!response.ok) { console.error(result.error || `HTTP ${response.status}`); process.exit(2); }
console.log(`Presented ${pages} page(s) of ${basename(pdf)} as /slides/${slug}/ (sharing ${options['no-share'] ? 'unchanged' : 'on'}).`);
