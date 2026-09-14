// Turn a PDF into picture slides for the presentation pane: each page is rendered with pdftoppm (poppler) into
// public/slides/<slug>/page-N.png, and the slides reference those files as image:/slides/<slug>/page-N.png.
import { execFile } from 'node:child_process';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

export async function renderPdfSlides(pdfPath, { slidesRoot, maxPages = 400, width = 1600 } = {}) {
  const file = resolve(pdfPath);
  if (extname(file).toLowerCase() !== '.pdf') throw new Error('Give a .pdf file.');
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new Error(`PDF not found: ${file}`);
  const slug = basename(file, '.pdf').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'deck';
  const dir = join(slidesRoot, slug);
  await mkdir(dir, { recursive: true });
  // pdftoppm writes page-1.png, page-2.png, ... (zero padding depends on the page count); -scale-to bounds the longer side.
  await execFileAsync('pdftoppm', ['-png', '-r', '110', '-scale-to', String(width), '-l', String(maxPages), file, join(dir, 'page')]);
  const files = (await readdir(dir)).filter(name => /^page-\d+\.png$/.test(name)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (!files.length) throw new Error('pdftoppm produced no pages.');
  return { slug, pages: files.length, slides: files.map((name, index) => ({ title: `Page ${index + 1}`, body: `image:/slides/${slug}/${name}` })) };
}
