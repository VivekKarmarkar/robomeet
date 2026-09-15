// Turn a PDF into picture slides for the presentation pane. The pane is a 1280x720 canvas, so a portrait page shown
// whole is unreadably small; by default each page is cut into horizontal bands of 16:9 (with a small overlap), each band
// rendered by pdftoppm at high resolution into public/slides/<slug>/, and the slides reference them as
// image:/slides/<slug>/<file>. bands: 'auto' (portrait pages banded, landscape pages whole), 1 (whole pages), or a number.
import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

async function pageSizes(file) {
  const { stdout } = await execFileAsync('pdfinfo', ['-f', '1', '-l', '400', file]);
  const sizes = [];
  for (const line of stdout.split('\n')) {
    const match = line.match(/^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+)/);
    if (match) sizes[Number(match[1]) - 1] = { width: Number(match[2]), height: Number(match[3]) };
  }
  return sizes;
}

export async function renderPdfSlides(pdfPath, { slidesRoot, maxPages = 400, width = 1920, bands = 'auto', overlap = 0.06 } = {}) {
  const file = resolve(pdfPath);
  if (extname(file).toLowerCase() !== '.pdf') throw new Error('Give a .pdf file.');
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new Error(`PDF not found: ${file}`);
  const slug = basename(file, '.pdf').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'deck';
  const dir = join(slidesRoot, slug);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const sizes = (await pageSizes(file)).slice(0, maxPages);
  if (!sizes.length) throw new Error('pdfinfo found no pages.');
  const slides = [];
  for (let index = 0; index < sizes.length; index++) {
    const page = index + 1, { width: pw, height: ph } = sizes[index];
    const dpi = Math.max(72, Math.round((width / pw) * 72));           // render so the page is `width` pixels wide
    const pxW = Math.round(pw * dpi / 72), pxH = Math.round(ph * dpi / 72);
    const bandCount = bands === 'auto' ? (ph > pw * 1.1 ? Math.max(1, Math.round(ph / (pw * 9 / 16) - overlap)) : 1) : Math.max(1, Number(bands) || 1);
    if (bandCount <= 1) {
      await execFileAsync('pdftoppm', ['-png', '-r', String(dpi), '-f', String(page), '-l', String(page), '-singlefile', file, join(dir, `page-${page}`)]);
      slides.push({ title: `Page ${page}`, body: `image:/slides/${slug}/page-${page}.png` });
      continue;
    }
    const bandH = Math.round(pxW * 9 / 16), step = Math.max(1, Math.round((pxH - bandH) / (bandCount - 1)));
    for (let band = 0; band < bandCount; band++) {
      const y = Math.min(band * step, Math.max(0, pxH - bandH));
      const name = `page-${page}-part-${band + 1}`;
      await execFileAsync('pdftoppm', ['-png', '-r', String(dpi), '-f', String(page), '-l', String(page), '-x', '0', '-y', String(y), '-W', String(pxW), '-H', String(Math.min(bandH, pxH - y)), '-singlefile', file, join(dir, name)]);
      slides.push({ title: `Page ${page} (${band + 1}/${bandCount})`, body: `image:/slides/${slug}/${name}.png` });
    }
  }
  const files = await readdir(dir);
  if (!files.length) throw new Error('pdftoppm produced no images.');
  return { slug, pages: sizes.length, slides };
}
