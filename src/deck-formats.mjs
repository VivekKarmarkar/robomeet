// Any presentable input -> stage deck (docs/stage-design.md), in the deck.json shape of src/deck-builder.mjs:
//   .pdf                           -> buildPdfDeck: fit-width reading windows
//   .pptx .ppt .odp (presentation) -> LibreOffice -> PDF -> one whole-page view per slide (fit 'page')
//   .docx .doc .odt .rtf (document)-> LibreOffice -> PDF -> fit-width windows (fit 'width')
//   .html .htm files, http(s) URLs -> headless Chrome, 1280 CSS px wide at device scale 1.5 (= 1920 device px): a
//                                     full-page screenshot is the page picture, the DOM's text lines plan fit-width
//                                     windows (planViews), and each window's exact render is a 1:1 crop of it. A URL
//                                     that serves a PDF or a picture is fetched and built as that kind.
//   .png .jpg .jpeg .webp          -> one whole view when at least as wide as 16:9, else uniform fit-width steps
// fit 'page': every page is one whole view, its exact render as large as fits 1920x1080 (letterboxed on the stage).
// fit 'width': fit-width windows stepping down the page, exact renders 1920x1080. Presentations default to 'page',
// everything else to 'width'. Needs poppler; LibreOffice for office files; Playwright + Chrome for web pages;
// ffmpeg/ffprobe for web pages and pictures.
// A deck that leaves part of its input out says so in deck.json: truncated { reason: 'maxPages', pages, totalPages }
// or { reason: 'page-height' | 'views', shownPx, totalPx }, each with a message to pass on.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createServer, request as httpRequest } from 'node:http';
import { BlockList, connect, isIP, isIPv6 } from 'node:net';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPdfDeck, parseBboxLayout, planViews, slugFor } from './deck-builder.mjs';

const run = promisify(execFile);
const STAGE_W = 1920;
const STAGE_H = 1080;
const CSS_W = 1280; // web viewport; x DPR 1.5 = 1920 device px, so a fit-width window is a 1:1 crop of the screenshot
const CSS_H = 720;
const DPR = 1.5;
const MAX_SHOT_H = 30000; // device px
const WEB_MARGIN = 24 * DPR; // device px of room below the last row of a web page, in its last window
const END_TOLERANCE = 0.0101; // planViews may stop once a window ends within 0.01 of the page end: content ends before that
const ROOM = STAGE_H / 4; // device px: taller pictures are not window-top obstacles; the last window moves at most this far
const OFFICE_TIMEOUT_MS = 120_000;
// A web page's whole capture (loading, capturing, cutting the renders). Past it the browser is closed and the build
// fails, so a page that never finishes loading or whose script never yields cannot hang the tool call.
const WEB_DEADLINE_MS = 90_000;
const MAX_FETCH_BYTES = 200 << 20; // a PDF or picture fetched from a URL
const CHROME = process.env.ROBOMEET_CHROME_PATH || '/usr/bin/google-chrome';
const SOFFICE = process.env.ROBOMEET_SOFFICE_PATH || 'soffice';
const WHOLE = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });
const FORMATS = {
  '.pdf': 'pdf',
  '.pptx': 'presentation', '.ppt': 'presentation', '.odp': 'presentation',
  '.docx': 'document', '.doc': 'document', '.odt': 'document', '.rtf': 'document',
  '.html': 'web', '.htm': 'web',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image',
};
export const DECK_INPUTS = Object.freeze(Object.keys(FORMATS));
// The slugs the server and present_deck accept (src/server.mjs, src/mcp.mjs): a deck under any other slug cannot be shown.
export const DECK_SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
// What a URL may serve, by content type: a page Chrome renders as a document, or a PDF or picture, fetched and built as
// that kind (Chrome would show those in its viewer, whose screenshot is not the document).
const PAGE_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain']);
const FETCHED = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
// ffmpeg filters that turn a stored picture upright by its EXIF Orientation (2-8), the way Chrome shows it.
const UPRIGHT = { 2: 'hflip', 3: 'hflip,vflip', 4: 'vflip', 5: 'transpose=cclock_flip', 6: 'transpose=clock', 7: 'transpose=clock_flip', 8: 'transpose=cclock' };

const r4 = value => Math.round(value * 1e4) / 1e4;
const r6 = value => Math.round(value * 1e6) / 1e6; // web pages run up to 30000 px tall: 1e-4 would be 3 px
const clamp01 = value => Math.min(1, Math.max(0, value));
const isFile = path => stat(path).then(info => info.isFile(), () => false);
const cancelled = () => new Error('Deck build cancelled: the deck already there (if any) was left as it was');

// Same rule as buildPdfDeck: <slidesRoot>/<slug> is removed and replaced by the new deck, so the slug must stay inside
// slidesRoot (and match the stage's /slides/<slug>/ asset paths).
function assertSafeSlug(slug) {
  if (typeof slug !== 'string' || !/^[A-Za-z0-9._-]+$/.test(slug) || /^\.+$/.test(slug)) throw new Error(`Unsafe deck slug: ${slug}`);
}

// ---- slugs
const shortHash = text => createHash('sha256').update(String(text)).digest('hex').slice(0, 8);
const unaccented = text => text.normalize('NFKD').replace(/[̀-ͯ]/g, ''); // Café -> Cafe: accented names keep their letters

// Default slug: slugFor(file) for files; hostname + path for web URLs. A file name with no Latin letter or digit
// (报告.pdf, Отчёт.docx) would be slugFor's 'deck' for every such file: it gets deck-<hash of its path> instead.
export function slugForInput(input) {
  const text = String(input);
  if (/^https?:\/\//i.test(text)) {
    const url = new URL(text);
    return `${url.hostname}${url.pathname}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 60).replace(/-+$/, '') || 'deck';
  }
  const file = /^file:/i.test(text) ? fileURLToPath(text) : text;
  const plain = unaccented(file);
  return /[a-z0-9]/i.test(basename(plain, extname(plain))) ? slugFor(plain) : `deck-${shortHash(resolve(file))}`;
}

// A deck's source (deck.json `source`, or a build input) as a comparable key: URLs normalized, paths absolute.
function sourceKey(source) {
  const text = String(source ?? '');
  try {
    if (/^https?:\/\//i.test(text)) return new URL(text).href;
    if (/^file:/i.test(text)) return resolve(fileURLToPath(text));
  } catch { return text; }
  return text ? resolve(text) : '';
}

// The source key of the deck in dir; null when dir does not exist; '' when it is there but not a deck with a source.
async function deckOwner(dir) {
  try { return sourceKey(JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8')).source); }
  catch { return (await stat(dir).then(() => true, () => false)) ? '' : null; }
}

// The slug a build of `input` should use under slidesRoot: slugForInput(input) when no deck is there yet or that deck
// was built from the same source (a rebuild), else the first such <slug>-2, <slug>-3, ... Default slugs of different
// sources can clean to the same name (report.pdf in two folders, view?id=1 and view?id=2, the 60-character cut), and a
// build replaces the deck under its slug: this keeps one source from destroying another source's deck.
export async function deckSlug(slidesRoot, input) {
  const base = slugForInput(input);
  const key = sourceKey(input);
  for (let n = 1; n < 1000; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const owner = await deckOwner(join(slidesRoot, slug));
    if (owner === null || owner === key) return slug;
  }
  throw new Error(`No free deck slug for ${input} under ${slidesRoot}`);
}

// Fit-width windows over a picture with no text: as planViews without lines would step (overlap >= `overlap`), but
// evenly spaced from the top edge to the bottom edge. A picture at least as wide as 16:9 is one whole view. Pure.
export function planUniformViews({ pageAspect, overlap = 0.1 }) {
  const h = (STAGE_H / STAGE_W) / pageAspect; // pageAspect = height / width
  if (!(h < 1)) return [{ ...WHOLE }];
  const count = Math.ceil((1 - h) / (h * (1 - overlap)) - 1e-9) + 1;
  return Array.from({ length: count }, (_, index) => ({ x: 0, y: index === count - 1 ? 1 - h : (1 - h) * index / (count - 1), w: 1, h }));
}

// Requests a captured page may make: http(s) (and inline data:, blob:, about:), and file:// only inside `root` (the
// local HTML file's own folder, symlinks resolved; null for web URLs). Everything else is refused. Where an http(s)
// request of a web URL page may connect is the network guard's rule (startGuard).
export async function webRequestAllowed(url, root) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (['http:', 'https:', 'data:', 'blob:', 'about:'].includes(parsed.protocol)) return true;
  if (parsed.protocol !== 'file:' || !root) return false;
  let path;
  try { path = fileURLToPath(parsed); } catch { return false; }
  const real = await realpath(path).catch(() => resolve(path));
  return real.startsWith(root + sep);
}

// input -> { kind, given?, file?, url?, root? }: an existing local file of a known type (`given` as the caller wrote
// it, `file` absolute, for tool arguments) or an http(s) URL. Nothing else.
async function classify(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('buildDeck needs a file path or an http(s) URL');
  let given = input;
  if (!(await isFile(input))) {
    const scheme = /^([a-z][a-z0-9+.-]+):/i.exec(input)?.[1]?.toLowerCase();
    if (scheme === 'http' || scheme === 'https') return { kind: 'web', url: new URL(input).href, root: null };
    if (scheme === 'file') given = fileURLToPath(input);
    else if (scheme) throw new Error(`Refusing ${scheme}: input: only local files and http(s) URLs can become decks`);
  }
  const file = resolve(given);
  const ext = extname(file).toLowerCase();
  if (ext === '.key') throw new Error('Keynote (.key) files are not supported (LibreOffice cannot convert them): export the presentation from Keynote as PDF or PowerPoint (.pptx) and build from that.');
  const kind = FORMATS[ext];
  if (!kind) throw new Error(`Unsupported input ${basename(file)}: give ${DECK_INPUTS.join(' ')} or an http(s) URL`);
  if (!(await isFile(file))) throw new Error(`No such file: ${input}`);
  if (kind !== 'web') return { kind, given, file };
  // The page is loaded from its real path and its folder is the real file's folder: a symlinked page would otherwise
  // be refused its own navigation by the folder rule (which resolves symlinks) as a file outside the link's folder.
  const real = await realpath(file);
  return { kind, given, file, url: pathToFileURL(real).href, root: dirname(real) };
}

// Builds a deck in a hidden staging slides root next to it and swaps <slidesRoot>/<slug> in only when the whole deck is
// written (as buildPdfDeck does): a failed or cancelled (signal) build never destroys the deck that is already there.
// build(stagingRoot, stagingDir) writes the files into stagingDir (= stagingRoot/<slug>) and returns the deck.
async function buildStaged(slidesRoot, slug, build, signal) {
  const staging = join(slidesRoot, `.${slug}.building-${process.pid}-${Date.now()}`);
  const stagingDir = join(staging, slug);
  const dir = join(slidesRoot, slug);
  await mkdir(stagingDir, { recursive: true });
  try {
    const { dir: _built, ...deck } = await build(staging, stagingDir);
    if (signal?.aborted) throw cancelled();
    await writeFile(join(stagingDir, 'deck.json'), JSON.stringify(deck, null, 2));
    await rm(dir, { recursive: true, force: true });
    await rename(stagingDir, dir);
    return { ...deck, dir };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// ---- pictures (ffmpeg)
// EXIF Orientation (1-8) of a JPEG (APP1 "Exif" segment) or a PNG (eXIf chunk), else 1. Chrome shows such a picture
// turned by it; it ignores a WebP's EXIF, and so does this. Only the file's head is read: EXIF comes before the pixels.
async function exifOrientation(file) {
  const handle = await open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(1 << 20), 0, 1 << 20, 0);
    return orientationIn(exifBlock(buffer.subarray(0, bytesRead)));
  } catch { return 1; } finally { await handle.close(); }
}
// The TIFF block of the EXIF data in a JPEG or PNG header, or null.
function exifBlock(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let at = 2; at + 4 <= bytes.length && bytes[at] === 0xff;) {
      const marker = bytes[at + 1];
      if (marker === 0xff) { at += 1; continue; } // fill byte
      if (marker === 0xda || marker === 0xd9) return null; // the pixels start: no EXIF in the header
      const length = bytes.readUInt16BE(at + 2);
      if (marker === 0xe1 && bytes.toString('latin1', at + 4, at + 10) === 'Exif\0\0') return bytes.subarray(at + 10, at + 2 + length);
      at += 2 + length;
    }
  } else if (bytes.toString('latin1', 1, 4) === 'PNG') {
    for (let at = 8; at + 8 <= bytes.length; at += 12 + bytes.readUInt32BE(at)) {
      const type = bytes.toString('latin1', at + 4, at + 8);
      if (type === 'eXIf') return bytes.subarray(at + 8, at + 8 + bytes.readUInt32BE(at));
      if (type === 'IDAT') return null;
    }
  }
  return null;
}
// Orientation tag (0x0112) of IFD0 in a TIFF block; 1 when absent.
function orientationIn(tiff) {
  if (!tiff || tiff.length < 8) return 1;
  const little = tiff.toString('latin1', 0, 2) === 'II';
  const u16 = at => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const ifd = little ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4);
  for (let index = 0, count = u16(ifd); index < count; index++) {
    const entry = ifd + 2 + 12 * index;
    if (u16(entry) === 0x0112) { const value = u16(entry + 8); return value >= 1 && value <= 8 ? value : 1; }
  }
  return 1;
}

// width x height as shown (EXIF orientation applied: a quarter turn swaps them), alpha, and `upright`, the ffmpeg
// filter that turns the stored pixels that way (null when they already are).
async function probePicture(file) {
  const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,pix_fmt', '-of', 'json', file]).catch(() => ({ stdout: '{}' }));
  const stream = JSON.parse(probe.stdout).streams?.[0];
  if (!(stream?.width > 0 && stream?.height > 0)) throw new Error(`Not a readable picture: ${basename(file)}`);
  const upright = UPRIGHT[await exifOrientation(file)] || null;
  const turned = /transpose/.test(upright || '');
  return { width: turned ? stream.height : stream.width, height: turned ? stream.width : stream.height, alpha: /rgba|bgra|argb|abgr|ya8|ya16|yuva|gbrap|pal8/.test(stream.pix_fmt || ''), upright };
}
// The pixels of `rect` (normalized) in a width x height picture, and the size its exact render gets: 1920x1080 for a
// fit-width window, else as large as fits 1920x1080 (no resampling when that is the crop's own size).
function renderJob(rect, { width, height }, file) {
  const sw = Math.max(1, Math.min(width, Math.round(rect.w * width)));
  const sh = Math.max(1, Math.min(height, Math.round(rect.h * height)));
  const sx = Math.max(0, Math.min(Math.round(rect.x * width), width - sw));
  const sy = Math.max(0, Math.min(Math.round(rect.y * height), height - sh));
  let tw = STAGE_W, th = STAGE_H;
  if (!(rect.w >= 1 && rect.h < 1)) {
    const scale = Math.min(STAGE_W / sw, STAGE_H / sh);
    tw = Math.min(STAGE_W, Math.max(1, Math.round(sw * scale)));
    th = Math.min(STAGE_H, Math.max(1, Math.round(sh * scale)));
  }
  return { file, crop: { x: sx, y: sy, w: sw, h: sh }, size: { w: tw, h: th } };
}
// All exact renders of one picture in one ffmpeg run (decoded once). RGB(A) first, so crops are pixel-exact.
// whole { filter, file }: the decoded picture first goes through `filter` (turning it upright, padding a web page to
// its planned height) and is also written whole to `file`; the crops are cut from that. The stored pixels are decoded
// as they are (-noautorotate): orientation comes only from this filter, as Chrome shows the picture. signal stops ffmpeg.
async function renderCrops(input, jobs, alpha, whole = null, signal) {
  const outputs = jobs.map(({ file, crop, size }) => ({ file, filter: `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}${size.w === crop.w && size.h === crop.h ? '' : `,scale=${size.w}:${size.h}:flags=lanczos`}` }));
  if (whole) outputs.push({ file: whole.file, filter: 'null' });
  if (!outputs.length) return;
  const head = `[0:v]format=${alpha ? 'rgba' : 'rgb24'}${whole ? `,${whole.filter}` : ''},split=${outputs.length}${outputs.map((_, index) => `[s${index}]`).join('')}`;
  const graph = [head, ...outputs.map((output, index) => `[s${index}]${output.filter}[o${index}]`)].join(';');
  await run('ffmpeg', ['-v', 'error', '-y', '-noautorotate', '-i', input, '-filter_complex', graph, ...outputs.flatMap((output, index) => ['-map', `[o${index}]`, '-frames:v', '1', output.file])], { maxBuffer: 16 << 20, signal });
}
// Colour of one pixel as 0xRRGGBB (white if it cannot be read).
async function pixelColor(file, x, y, signal) {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file, '-vf', `crop=1:1:${x}:${y},format=rgb24`, '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 20, signal });
  return stdout.length >= 3 ? `0x${stdout.subarray(0, 3).toString('hex')}` : '0xffffff';
}

// The picture (probePicture) is the page picture. A picture Chrome shows turned by its EXIF orientation gets an upright
// PNG as page picture instead of the stored bytes, written in the same ffmpeg run as the renders, so the page picture,
// the renders and pageWidth x pageHeight all show it the way the stage does. Its views: one whole view (the picture as
// its render when it fits the stage, else a render scaled to fit), or uniform fit-width steps with 1920x1080 crops.
async function imageDeckInto(dir, file, picture, { slug, title, fit, source }) {
  const body = picture.upright ? 'page-1.png' : `page-1${extname(file).toLowerCase()}`;
  if (!picture.upright) await copyFile(file, join(dir, body));
  const rects = fit === 'page' ? [{ ...WHOLE }] : planUniformViews({ pageAspect: picture.height / picture.width });
  const jobs = [];
  const views = rects.map((rect, index) => {
    const view = { ...rect, lines: [], blocks: [] };
    if (rect.h >= 1 && picture.width <= STAGE_W && picture.height <= STAGE_H) view.asset = `/slides/${slug}/${body}`; // fits the stage as it is
    else {
      const name = `page-1-view-${index + 1}.png`;
      jobs.push(renderJob(rect, picture, join(dir, name)));
      view.asset = `/slides/${slug}/${name}`;
    }
    return view;
  });
  if (picture.upright) await renderCrops(file, jobs, picture.alpha, { filter: picture.upright, file: join(dir, body) });
  else await renderCrops(join(dir, body), jobs, picture.alpha);
  const slides = [{ title: 'Page 1', body: `image:/slides/${slug}/${body}`, page: 1, pageWidth: picture.width, pageHeight: picture.height, views }];
  return { title: title || slug, slug, source, pages: 1, slides };
}

async function buildImageDeck(file, { slidesRoot, slug, title, fit, source, signal }) {
  const picture = await probePicture(file); // before any deck directory is touched
  return buildStaged(slidesRoot, slug, (_staging, dir) => imageDeckInto(dir, file, picture, { slug, title, fit, source }), signal);
}

// ---- PDF and office documents
// Kills the whole process group on timeout or when signal aborts (soffice is a wrapper around soffice.bin).
function runGroup(command, args, timeoutMs, signal) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const keep = chunk => { output = (output + chunk).slice(-4000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', kill); };
    child.on('error', error => { done(); reject(new Error(`Cannot run ${command}: ${error.message}`)); });
    child.on('close', code => { done(); resolveRun({ code, timedOut, output }); });
  });
}

// soffice --headless --convert-to pdf, with a private profile (never meets a running LibreOffice) and a timeout.
async function officeToPdf(file, timeoutMs = OFFICE_TIMEOUT_MS, signal) {
  const work = await mkdtemp(join(tmpdir(), 'robomeet-office-'));
  const cleanup = () => rm(work, { recursive: true, force: true });
  try {
    const outdir = join(work, 'out');
    const { code, timedOut, output } = await runGroup(SOFFICE, [`-env:UserInstallation=${pathToFileURL(join(work, 'profile')).href}`,
      '--headless', '--norestore', '--nolockcheck', '--convert-to', 'pdf', '--outdir', outdir, file], timeoutMs, signal);
    const pdf = (await readdir(outdir).catch(() => [])).find(name => name.toLowerCase().endsWith('.pdf'));
    if (!pdf) {
      const why = timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s` : `exit ${code}`;
      throw new Error(`LibreOffice could not convert ${basename(file)} to PDF (${why}): ${output.trim().split('\n').slice(-3).join(' ').slice(0, 400)}`);
    }
    return { pdf: join(outdir, pdf), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

// fit 'page' on a deck from buildPdfDeck (built with exactViews: false): every page becomes one whole view with all its
// text lines and blocks, and an exact render as large as fits 1920x1080, cut with pdftoppm as deck-builder does.
async function wholePageViews(deck, pdf, maxPages) {
  const { stdout } = await run('pdftotext', ['-bbox-layout', '-l', String(maxPages), pdf, '-'], { maxBuffer: 512 << 20 });
  const layout = parseBboxLayout(stdout);
  for (const slide of deck.slides) {
    const page = layout[slide.page - 1] || { blocks: [] };
    const W = slide.pageWidth; // points, already swapped by buildPdfDeck for /Rotate 90 and 270 pages
    const H = slide.pageHeight;
    const lines = page.blocks.flatMap(block => block.lines).map(line => ({ text: line.text, x: r4(line.x0 / W), y: r4(line.y0 / H), w: r4((line.x1 - line.x0) / W), h: r4((line.y1 - line.y0) / H) }));
    const blocks = page.blocks.map(block => ({ x: r4(block.x0 / W), y: r4(block.y0 / H), w: r4((block.x1 - block.x0) / W), h: r4((block.y1 - block.y0) / H), text: block.lines.map(line => line.text).join(' ') }));
    const widthIn = W / 72;
    const heightIn = H / 72;
    const dpi = Number(Math.min(STAGE_W / widthIn, STAGE_H / heightIn).toFixed(4));
    const width = Math.min(STAGE_W, Math.round(widthIn * dpi));
    const height = Math.min(STAGE_H, Math.round(heightIn * dpi));
    const name = `page-${slide.page}-view-1`;
    await run('pdftoppm', ['-png', '-r', dpi.toFixed(4), '-f', String(slide.page), '-l', String(slide.page), '-x', '0', '-y', '0', '-W', String(width), '-H', String(height), '-singlefile', pdf, join(deck.dir, name)]);
    slide.views = [{ ...WHOLE, lines, blocks, asset: `/slides/${deck.slug}/${name}.png` }];
  }
  return deck;
}

// Page count from pdfinfo (null when it cannot tell), so a deck cut at maxPages can say so.
async function pdfPageCount(pdf) {
  try { return Number(/^Pages:\s+(\d+)/m.exec((await run('pdfinfo', [pdf], { maxBuffer: 16 << 20 })).stdout)?.[1]) || null; } catch { return null; }
}
const pagesCut = (total, maxPages) => (total > maxPages
  ? { reason: 'maxPages', pages: maxPages, totalPages: total, message: `Stopped at ${maxPages} of ${total} pages (maxPages ${maxPages}): the rest of the document is not in the deck.` }
  : null);

// A .pdf with fit 'width' is exactly buildPdfDeck, unless deck.json must say the document was cut at maxPages or a
// cancel (signal) must be able to stop the swap. Otherwise buildPdfDeck builds into a staging slides root, the deck is
// post-processed there (fit 'page') and its source set to the original file (an office file's PDF is temporary).
async function buildFromPdf(pdf, { slidesRoot, slug, title, fit, maxPages, pageWidth, source, signal }) {
  const truncated = pagesCut(await pdfPageCount(pdf), maxPages);
  if (fit !== 'page' && source === pdf && !truncated && !signal) return buildPdfDeck(pdf, { slidesRoot, slug, title, maxPages, ...(pageWidth ? { pageWidth } : {}) });
  return buildStaged(slidesRoot, slug, staging => pdfDeckInto(staging, pdf, { slug, title, fit, maxPages, pageWidth, source, truncated }), signal);
}
async function pdfDeckInto(staging, pdf, { slug, title, fit, maxPages, pageWidth, source, truncated }) {
  const deck = await buildPdfDeck(pdf, { slidesRoot: staging, slug, title, maxPages, ...(pageWidth ? { pageWidth } : {}), exactViews: fit !== 'page' });
  if (fit === 'page') await wholePageViews(deck, pdf, maxPages);
  return { ...deck, source, ...(truncated ? { truncated } : {}) };
}

// ---- the network guard for web URL pages
// Addresses a page from the web must not reach unless it is itself there: loopback, private networks, link-local (the
// cloud metadata address 169.254.169.254), carrier-grade NAT, 0.0.0.0 (this machine), multicast and reserved.
// IPv4-mapped IPv6 addresses match the IPv4 rules (net.BlockList).
const LOCAL_NETS = new BlockList();
for (const [net, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3]]) LOCAL_NETS.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) LOCAL_NETS.addSubnet(net, prefix, 'ipv6');
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');
const family = address => (isIPv6(address) ? 'ipv6' : 'ipv4');
export const isLocalAddress = address => LOCAL_NETS.check(address, family(address));
const isLoopback = address => LOOPBACK.check(address, family(address));
const bare = host => String(host).replace(/^\[|\]$/g, ''); // URL hostnames keep IPv6 brackets
const addressesOf = async host => (isIP(bare(host)) ? [{ address: bare(host), family: isIP(bare(host)) }] : lookup(bare(host), { all: true, verbatim: true }));
const HOP_HEADERS = new Set(['connection', 'proxy-connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const endToEnd = headers => Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_HEADERS.has(name)));
const GUARD_HEADER = 'x-robomeet-guard'; // on the answers the guard gives itself (a refusal, an unreachable host)

// A forward proxy that Chrome and context.request use for a web URL page, loopback included (Playwright's proxy option
// adds <-loopback>): every request, redirect hop and WebSocket of the page connects through it, to the addresses it
// resolved and checked itself (a DNS answer cannot change between the check and the connection). It refuses local-network
// addresses unless the page's own host is there (a local or intranet page asked for by name may load from its own
// machine), so a page from the web cannot frame a local service into the shared deck. Route handlers alone cannot do
// this: Playwright does not route redirect hops or WebSockets. problems: host -> why it failed, for error messages.
async function startGuard(pageUrl) {
  const own = await addressesOf(new URL(pageUrl).hostname).catch(() => []);
  const ownAddresses = new Set(own.map(entry => entry.address));
  const ownLoopback = own.some(entry => isLoopback(entry.address)); // 127.0.0.1 and ::1 are the same machine
  const reachable = address => !isLocalAddress(address) || ownAddresses.has(address) || (ownLoopback && isLoopback(address));
  const problems = new Map();
  const checked = async host => {
    const found = await addressesOf(host).catch(() => []);
    const local = found.find(entry => !reachable(entry.address));
    if (found.length && !local) return found;
    problems.set(bare(host), found.length ? `${local.address} is a local-network address, which a page from the web may not reach` : 'does not resolve');
    return null;
  };
  const pinned = found => (_host, options, done) => (options?.all ? done(null, found) : done(null, found[0].address, found[0].family));
  const tunnels = new Set();
  const server = createServer(async (request, response) => { // plain http://: absolute-form request URLs
    let url;
    try { url = new URL(request.url); } catch { response.writeHead(400).end(); return; }
    const found = await checked(url.hostname);
    if (!found) { response.writeHead(403, { 'content-type': 'text/plain', [GUARD_HEADER]: 'refused' }).end(`RoboMeet did not load ${url.host}: ${problems.get(bare(url.hostname))}`); return; }
    const upstream = httpRequest({ host: bare(url.hostname), port: url.port || 80, method: request.method, path: `${url.pathname}${url.search}`, headers: endToEnd(request.headers), lookup: pinned(found), agent: false });
    upstream.on('response', reply => { response.writeHead(reply.statusCode, reply.statusMessage, endToEnd(reply.headers)); reply.pipe(response); });
    upstream.on('error', error => {
      if (response.headersSent) { response.destroy(); return; }
      problems.set(bare(url.hostname), `could not connect (${error.code || error.message})`);
      response.writeHead(502, { 'content-type': 'text/plain', [GUARD_HEADER]: 'unreachable' }).end(`RoboMeet could not reach ${url.host}`);
    });
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on('connect', async (request, socket, head) => { // https:// and WebSockets: CONNECT host:port tunnels
    tunnels.add(socket);
    socket.on('close', () => tunnels.delete(socket));
    socket.on('error', () => {});
    const [, host, port] = /^\[?([^\]]*?)\]?:(\d+)$/.exec(request.url) || [];
    const found = host && await checked(host);
    if (!found) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    let open = false;
    const upstream = connect({ host, port: Number(port), lookup: pinned(found) }, () => {
      open = true;
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', error => {
      if (open) { socket.destroy(); return; }
      problems.set(host, `could not connect (${error.code || error.message})`);
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    socket.on('close', () => upstream.destroy());
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return {
    server: `http://127.0.0.1:${server.address().port}`,
    problems,
    close: () => { for (const socket of tunnels) socket.destroy(); server.closeAllConnections(); return new Promise(done => server.close(() => done())); },
  };
}
// What the guard refused or could not reach, for an error message: the page's own host first, then local-network
// refusals (Chrome's own background requests can fail too, offline).
function guardNote(guard, url) {
  if (!guard?.problems.size) return '';
  const own = bare(new URL(url).hostname);
  const rank = ([host, why]) => (host === own ? 0 : /local-network/.test(why) ? 1 : 2);
  return ` (${[...guard.problems].sort((a, b) => rank(a) - rank(b)).slice(0, 3).map(([host, why]) => `${host}: ${why}`).join('; ')})`;
}
// The guard's note when an HTTP error response is one the guard gave.
const guardAnswer = (response, guard, url) => (response?.headers()[GUARD_HEADER] ? guardNote(guard, url) : '');

// ---- web pages (Playwright)
// Runs in the page: text line boxes in page CSS px, from Range client rects of every visible word of every text node,
// clipped by overflow ancestors, grouped into visual lines (same block, same row, left to right), plus the union of
// the lines of each block-level element, and the boxes of visible pictures (a formula image, an icon, inline math), which
// a window top must not cut either.
function collectText() {
  const root = document.documentElement;
  const sx = window.scrollX, sy = window.scrollY;
  const styles = new Map();
  const styleOf = el => { let style = styles.get(el); if (!style) { style = getComputedStyle(el); styles.set(el, style); } return style; };
  const NONE = { x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity };
  const clips = new Map();
  const clipOf = el => {
    if (!el || el === root || el === document.body) return NONE;
    if (clips.has(el)) return clips.get(el);
    const outer = clipOf(el.parentElement);
    const style = styleOf(el);
    let box = outer;
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
      const rect = el.getBoundingClientRect();
      box = { x0: Math.max(outer.x0, rect.left + sx), y0: Math.max(outer.y0, rect.top + sy), x1: Math.min(outer.x1, rect.right + sx), y1: Math.min(outer.y1, rect.bottom + sy) };
    }
    clips.set(el, box);
    return box;
  };
  const faded = new Map();
  const transparent = el => {
    if (!el || el === root) return false;
    if (!faded.has(el)) faded.set(el, Number(styleOf(el).opacity) === 0 || transparent(el.parentElement));
    return faded.get(el);
  };
  const blockIds = new Map();
  const blockOf = el => {
    let node = el;
    while (node && node !== root && ['inline', 'contents'].includes(styleOf(node).display)) node = node.parentElement;
    node = node || root;
    if (!blockIds.has(node)) blockIds.set(node, blockIds.size);
    return blockIds.get(node);
  };
  const words = [];
  const range = document.createRange();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || !/\S/.test(node.data) || el.closest('head, script, style, noscript, template, textarea, select')) continue;
    if (styleOf(el).visibility !== 'visible' || transparent(el)) continue;
    const clip = clipOf(el);
    const block = blockOf(el);
    for (const match of node.data.matchAll(/\S+/g)) {
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      const rect = [...range.getClientRects()].find(item => item.width > 0 && item.height > 0);
      if (!rect) continue;
      const box = { x0: Math.max(rect.left + sx, clip.x0), y0: Math.max(rect.top + sy, clip.y0), x1: Math.min(rect.right + sx, clip.x1), y1: Math.min(rect.bottom + sy, clip.y1) };
      if (box.x1 - box.x0 <= 1 || box.y1 - box.y0 <= 1) continue; // clipped away (scrolled out, 1 px visually-hidden box)
      words.push({ ...box, text: match[0], node, block });
    }
  }
  const lines = [];
  let line = null;
  let lastNode = null;
  for (const word of words) {
    const overlap = line ? Math.min(word.y1, line.y1) - Math.max(word.y0, line.y0) : 0;
    const joins = line && word.block === line.block && overlap > 0.5 * Math.min(word.y1 - word.y0, line.y1 - line.y0)
      && word.x0 >= line.x1 - 2 && word.x0 - line.x1 < 3 * (word.y1 - word.y0);
    if (joins) {
      line.text += word.node === lastNode || word.x0 - line.x1 > 1 ? ` ${word.text}` : word.text;
      line.x1 = Math.max(line.x1, word.x1);
      line.y0 = Math.min(line.y0, word.y0);
      line.y1 = Math.max(line.y1, word.y1);
    } else lines.push(line = { x0: word.x0, y0: word.y0, x1: word.x1, y1: word.y1, text: word.text, block: word.block });
    lastNode = word.node;
  }
  const figures = [];
  for (const el of document.querySelectorAll('img, svg, math, canvas, video, iframe, object, embed')) {
    const style = styleOf(el);
    if (style.display === 'none' || style.visibility !== 'visible' || transparent(el)) continue;
    const rect = el.getBoundingClientRect();
    const clip = clipOf(el.parentElement);
    const box = { x0: Math.max(rect.left + sx, clip.x0), y0: Math.max(rect.top + sy, clip.y0), x1: Math.min(rect.right + sx, clip.x1), y1: Math.min(rect.bottom + sy, clip.y1) };
    if (box.x1 - box.x0 > 1 && box.y1 - box.y0 > 1) figures.push(box);
  }
  const blocks = new Map();
  for (const item of lines) {
    const block = blocks.get(item.block);
    if (!block) { blocks.set(item.block, { x0: item.x0, y0: item.y0, x1: item.x1, y1: item.y1, text: item.text }); continue; }
    Object.assign(block, { x0: Math.min(block.x0, item.x0), y0: Math.min(block.y0, item.y0), x1: Math.max(block.x1, item.x1), y1: Math.max(block.y1, item.y1), text: `${block.text} ${item.text}` });
  }
  return {
    title: String(document.title || '').trim(),
    height: Math.max(root.scrollHeight, document.body ? document.body.scrollHeight : 0),
    lines: lines.map(({ block, ...rest }) => rest),
    blocks: [...blocks.values()],
    figures,
  };
}

// Scrolls once through the page (bounded) so lazy content loads, then back to the top.
async function scrollThrough({ maxY, step, pauseMs, budgetMs }) {
  const start = performance.now();
  const pause = () => new Promise(done => setTimeout(done, pauseMs));
  for (let y = step; y < Math.min(maxY, document.documentElement.scrollHeight) && performance.now() - start < budgetMs; y += step) {
    window.scrollTo({ top: y, behavior: 'instant' });
    await pause();
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
  await pause();
}

// Rejects when `promise` has not settled after ms: page.evaluate has no timeout of its own, and a page whose script
// never yields would hang the build. The error is marked `late`, so a best-effort step can tell a hung page (fatal)
// from an ordinary failure (skipped).
function within(ms, promise, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${what} did not finish within ${ms / 1000} s: the page stopped responding (a script that never yields?)`), { late: true })), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}
const unlessLate = error => { if (error?.late) throw error; };
const typeOf = response => String(response?.headers()['content-type'] || '').split(';')[0].trim().toLowerCase();
const frameOf = request => { try { return request.frame(); } catch { return null; } };

// Headless Chrome with its renderer sandbox: Playwright passes --no-sandbox unless chromiumSandbox is true, and a web
// page is untrusted content. Only where the sandbox cannot start (no user namespaces, running as root) does the
// capture go on without it, saying why on stderr.
async function launchChrome(options) {
  const { chromium } = await import('playwright');
  // P7: sites that refuse automated browsers (openai.com answered 403) look at the automation flag.
  const launch = sandbox => chromium.launch({ executablePath: CHROME, headless: true, chromiumSandbox: sandbox, timeout: 30_000, ...options, args: [...(options?.args || []), '--disable-blink-features=AutomationControlled'] });
  try {
    return await launch(true);
  } catch (error) {
    const reason = String(error?.message || error).split('\n').find(line => /sandbox/i.test(line));
    if (!reason) throw error;
    console.warn(`RoboMeet deck: Chrome's sandbox cannot start here, so the page is captured without it (${reason.trim().slice(0, 300)})`);
    return launch(false);
  }
}

// page.goto's error in plain words: a download is not a page, and the guard says why a connection failed.
function loadError(error, target, guard) {
  const message = String(error?.message || error);
  if (/Download is starting/i.test(message)) return new Error(`${target.url} is a file download, not a web page: download it and build the deck from the file`);
  return guard && /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY/.test(message) ? new Error(`${message.split('\n')[0]}${guardNote(guard, target.url)}`) : error;
}

// The page must still be the one asked for: a navigation of the page that the request policy refused, a failed load
// (Chrome's error page), an HTTP error or a move to a PDF after load would otherwise be captured as if it were the page.
function assertOnPage(page, main, target, refused, guard) {
  const name = target.given || target.url;
  if (refused) throw new Error(`${name} moved to ${refused}, which a deck may not load (a local page may only load files in its own folder)`);
  if (page.url().startsWith('chrome-error:')) throw new Error(`${name} did not load: Chrome shows its error page${guardNote(guard, target.url)}`);
  if (main && main.status() >= 400) throw new Error(`HTTP ${main.status()} for ${main.url()}${guardAnswer(main, guard, target.url)}`);
  const type = typeOf(main);
  if (!target.root && type && !PAGE_TYPES.has(type)) throw new Error(`${name} moved to ${main.url()}, which serves ${type}: build the deck from that URL instead`);
}

// A PDF or picture that a URL serves, fetched again through the browser context (its cookies, its proxy: the guard)
// into a temporary folder. Returns { dir, file, kind }.
async function fetchFile(context, url, response) {
  const tooBig = bytes => new Error(`${url} is ${Math.round(bytes / 2 ** 20)} MB, over the ${MAX_FETCH_BYTES / 2 ** 20} MB a fetched file may be: download it and build the deck from the file`);
  const declared = Number(response?.headers()['content-length']);
  if (declared > MAX_FETCH_BYTES) throw tooBig(declared);
  const got = await context.request.get(url, { timeout: 60_000, maxRedirects: 10 });
  if (got.status() >= 400) throw new Error(`HTTP ${got.status()} for ${url}`);
  const ext = FETCHED[typeOf(got)];
  if (!ext) throw new Error(`${url} served ${typeOf(got) || 'no content type'} when fetched again: not a PDF or picture`);
  const body = await got.body();
  if (body.length > MAX_FETCH_BYTES) throw tooBig(body.length);
  const dir = await mkdtemp(join(tmpdir(), 'robomeet-url-'));
  try {
    await writeFile(join(dir, `download${ext}`), body);
    return { dir, file: join(dir, `download${ext}`), kind: ext === '.pdf' ? 'pdf' : 'image' };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

// Loads the page and returns its text (collectText) and a full-page screenshot written to `file`: 1280 CSS px wide at
// device scale 1.5, at most MAX_SHOT_H device px tall. A URL that serves a PDF or a picture returns { fetched } (the
// file, in a temporary folder) instead. Every step is bounded, and `signal` (the deadline, a cancel) closes the
// browser, which ends whatever step is running. A web URL page goes through the network guard; a local HTML file
// keeps the folder rule.
async function capturePage(target, file, signal) {
  const guard = target.root ? null : await startGuard(target.url);
  let browser = null;
  const close = () => browser?.close().catch(() => {});
  signal.addEventListener('abort', close, { once: true });
  try {
    browser = await launchChrome(guard ? { proxy: { server: guard.server } } : {});
    signal.throwIfAborted();
    // P7: the user agent of the same Chrome, without "HeadlessChrome" (openai.com refused that one with HTTP 403).
    const context = await browser.newContext({ viewport: { width: CSS_W, height: CSS_H }, deviceScaleFactor: DPR, userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36` });
    let page = null;
    let refused = null; // a navigation of the page itself that the request policy stopped
    const isMain = request => page !== null && request.isNavigationRequest() && frameOf(request) === page.mainFrame();
    await context.route('**/*', async route => {
      if (await webRequestAllowed(route.request().url(), target.root)) return route.continue();
      if (isMain(route.request())) refused = route.request().url();
      return route.abort('accessdenied');
    });
    page = await context.newPage();
    let main = null; // the page's latest document response: redirects and navigations after load included
    page.on('response', response => { if (isMain(response.request())) main = response; });
    const response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(error => { throw loadError(error, target, guard); });
    if (response && response.status() >= 400) throw new Error(`HTTP ${response.status()} for ${target.url}${guardAnswer(response, guard, target.url)}`);
    if (!target.root) {
      const type = typeOf(response) || String(await within(5_000, page.evaluate(() => document.contentType), 'Reading the content type').catch(unlessLate) || '');
      if (FETCHED[type]) {
        await page.close().catch(() => {}); // Chrome's viewer would download it a second time
        return { fetched: await fetchFile(context, response?.url() || target.url, response) };
      }
      if (!PAGE_TYPES.has(type)) throw new Error(`${target.url} serves ${type || 'content of no stated type'}: only web pages, PDFs and pictures (png, jpeg, webp) can become decks`);
    }
    await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    await within(12_000, page.evaluate(scrollThrough, { maxY: MAX_SHOT_H / DPR, step: CSS_H, pauseMs: 60, budgetMs: 4_000 }), 'Scrolling through the page').catch(unlessLate);
    await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
    await within(8_000, page.evaluate(() => Promise.race([document.fonts.ready, new Promise(done => setTimeout(done, 3_000))]).then(() => true)), 'Waiting for fonts').catch(unlessLate);
    assertOnPage(page, main, target, refused, guard);
    const text = await within(20_000, page.evaluate(collectText), 'Reading the page text');
    const heightCss = Math.max(1, Math.min(Math.ceil(text.height), Math.floor(MAX_SHOT_H / DPR)));
    const shot = await page.screenshot({ path: file, fullPage: true, clip: { x: 0, y: 0, width: CSS_W, height: heightCss }, animations: 'disabled', timeout: 60_000 });
    return { text, heightCss, width: shot.readUInt32BE(16), height: shot.readUInt32BE(20), alpha: [4, 6].includes(shot[25]) };
  } finally {
    signal.removeEventListener('abort', close);
    await close();
    await guard?.close();
  }
}

// Fit-width windows over a web page from its rows (text lines and small pictures; device px, x normalized), with
// planViews. A web page has no print margins: a zero-height row at the page top makes the first window start at the top
// (a logo or picture above the first text is not cut off), and the last window is the picture's last 1080 px, the
// picture's end chosen so that window starts between rows, shows every row with WEB_MARGIN px to spare and stays inside
// planViews' 1% end tolerance; the picture is extended (in the page's own colour) when that end lies past it. Rows go
// to planViews under a neutral label: its page-number rule (short text in the bottom tenth) is for PDFs.
// Returns { rects, height } (height: the picture's height after any extension).
function planWebViews(rows, width, height) {
  const last = Math.max(...rows.map(row => row.y1));
  // One top window only when the whole picture fits it: below the last row there can still be a figure, canvas or
  // frame taller than ROOM (not a row), and the windows must reach the picture's end to show it.
  if (last <= STAGE_H && height <= STAGE_H) return { height, rects: [{ x: 0, y: 0, w: 1, h: Math.min(1, STAGE_H / height) }] };
  let top = Math.max(height, last + WEB_MARGIN, last / (1 - END_TOLERANCE)) - STAGE_H;
  const inside = rows.findIndex(row => row.y0 < top && top < row.y1);
  // Inside a row: move down to the gap after it, unless it is the last row or a solid block (columns whose lines
  // interleave) taller than ROOM, where no gap is within reach.
  if (inside >= 0 && rows[inside + 1] && rows[inside].y1 - top <= ROOM) top = (rows[inside].y1 + rows[inside + 1].y0) / 2;
  const padded = Math.min(MAX_SHOT_H, Math.max(height, Math.ceil(top + STAGE_H)));
  const lines = [{ y0: 0, y1: 0 }, ...rows.map(row => ({ y0: row.y0 / padded, y1: row.y1 / padded }))].map(row => ({ x0: 0, x1: 1, ...row, text: 'page row' }));
  // margin 1: the content counts as reaching the picture's end, so the last window is exactly its last 1080 px.
  return { height: padded, rects: planViews({ pageAspect: padded / width, lines, margin: 1 }) };
}

// What a web deck leaves out: the page below the page picture's cap (MAX_SHOT_H), or the picture below its last window
// (planViews stops at 60 windows). Null when the views reach the page's end. Device px, as pageHeight.
function webCut(pagePx, capturedPx, rects, height) {
  const coveredPx = Math.round(Math.max(...rects.map(rect => rect.y + rect.h)) * height);
  const totalPx = Math.round(pagePx);
  if (capturedPx < totalPx - 1) {
    const shownPx = Math.min(coveredPx, capturedPx);
    return { reason: 'page-height', shownPx, totalPx, message: `Web page cut at ${shownPx} of ${totalPx} px (${Math.round(100 * shownPx / totalPx)}%): a page picture stops at ${MAX_SHOT_H} px, so the rest of the page is not in the deck.` };
  }
  if (coveredPx < height * (1 - END_TOLERANCE)) return { reason: 'views', shownPx: coveredPx, totalPx: height, message: `The views stop at ${coveredPx} of ${height} px: the rest of the page is in no view.` };
  return null;
}

// A captured web page -> its deck: the page picture, fit-width windows (planWebViews) or one whole view, exact renders.
async function pageDeck(shot, capture, dir, { slug, title, fit, source }, signal) {
  const { text, heightCss } = shot;
  // CSS px -> device px (y) and page fraction (x); only what the screenshot holds.
  const sy = shot.height / heightCss;
  const inPage = box => box.y0 < heightCss && box.y1 > 0 && box.x1 > 0 && box.x0 < CSS_W;
  const toPx = box => ({ x0: clamp01(box.x0 / CSS_W), x1: clamp01(box.x1 / CSS_W), y0: Math.max(0, box.y0 * sy), y1: Math.min(shot.height, box.y1 * sy), text: box.text });
  const linesPx = text.lines.filter(inPage).map(toPx);
  const blocksPx = text.blocks.filter(inPage).map(toPx);
  // Pictures up to ROOM px tall are obstacles for window tops too; a taller figure is cut wherever a window starts,
  // and as one tall row it would swallow the gaps between the text rows beside it.
  const figuresPx = text.figures.filter(inPage).map(toPx).filter(figure => figure.y1 - figure.y0 <= ROOM);
  // Rows: everything on one visual row (across columns and blocks), as planViews groups lines.
  const rows = [];
  for (const line of [...linesPx, ...figuresPx].sort((a, b) => a.y0 - b.y0)) {
    const row = rows.at(-1);
    if (row && line.y0 < row.y1) row.y1 = Math.max(row.y1, line.y1);
    else rows.push({ y0: line.y0, y1: line.y1 });
  }
  let height = shot.height;
  let rects;
  if (fit === 'page') rects = [{ ...WHOLE }];
  else if (!rows.length) rects = planUniformViews({ pageAspect: height / shot.width }); // no text or small pictures: plain steps
  else ({ rects, height } = planWebViews(rows, shot.width, shot.height));
  const box = item => ({ x: r6(item.x0), y: r6(item.y0 / height), w: r6(item.x1 - item.x0), h: r6((item.y1 - item.y0) / height) });
  const lines = linesPx.map(line => ({ text: line.text, ...box(line) }));
  const blocks = blocksPx.map(block => ({ ...box(block), text: block.text }));
  const picture = { width: shot.width, height };
  const jobs = [];
  const views = rects.map((rect, index) => {
    const within = item => item.y + item.h / 2 >= rect.y && item.y + item.h / 2 <= rect.y + rect.h;
    const name = `page-1-view-${index + 1}.png`;
    jobs.push(renderJob(rect, picture, join(dir, name)));
    return { ...rect, lines: lines.filter(within), blocks: blocks.filter(within), asset: `/slides/${slug}/${name}` };
  });
  if (height > shot.height) {
    // The page's colour a few rows above its end (the last device row can be half-covered when height x 1.5 is fractional).
    const color = await pixelColor(capture, 0, Math.max(0, shot.height - 3), signal);
    await renderCrops(capture, jobs, shot.alpha, { filter: `pad=iw:${height}:0:0:color=${color}`, file: join(dir, 'page-1.png') }, signal);
    await rm(capture, { force: true });
  } else {
    await rename(capture, join(dir, 'page-1.png'));
    await renderCrops(join(dir, 'page-1.png'), jobs, shot.alpha, null, signal);
  }
  const slides = [{ title: 'Page 1', body: `image:/slides/${slug}/page-1.png`, page: 1, pageWidth: shot.width, pageHeight: height, views }];
  const truncated = webCut(text.height * sy, shot.height, rects, height);
  return { title: title || text.title || slug, slug, source, pages: 1, slides, ...(truncated ? { truncated } : {}) };
}

// A PDF or picture fetched from a URL, built as that kind in the staging folder (as a local file would be, not under
// the web deadline); the temporary download is removed.
async function fetchedDeck({ dir: download, file, kind }, staging, dir, options) {
  try {
    if (kind === 'image') return await imageDeckInto(dir, file, await probePicture(file), options);
    return await pdfDeckInto(staging, file, { ...options, truncated: pagesCut(await pdfPageCount(file), options.maxPages) });
  } finally {
    await rm(download, { recursive: true, force: true });
  }
}

// Web pages (a local HTML file, an http(s) URL) under a hard deadline for loading, capturing and cutting the renders:
// when it passes, the browser is closed, the staging folder removed and the build fails with a plain message.
async function buildWebDeck(target, { slidesRoot, slug, title, fit, maxPages, pageWidth, signal, deadlineMs = WEB_DEADLINE_MS }) {
  const deadline = AbortSignal.timeout(deadlineMs);
  const stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const failure = error => (signal?.aborted ? cancelled()
    : deadline.aborted ? new Error(`Gave up on ${target.given || target.url} after ${deadlineMs / 1000} s: the page did not finish loading and capturing in time (the browser was closed and no deck was changed)`)
    : error);
  return buildStaged(slidesRoot, slug, async (staging, dir) => {
    const capture = join(dir, 'capture.png');
    const shot = await capturePage(target, capture, stop).catch(error => { throw failure(error); });
    if (shot.fetched) return fetchedDeck(shot.fetched, staging, dir, { slug, title, fit, maxPages, pageWidth, source: target.url });
    try { return await pageDeck(shot, capture, dir, { slug, title, fit, source: target.given || target.url }, stop); }
    catch (error) { throw failure(error); }
  }, signal);
}

// ---- entry point
// Same return shape as buildPdfDeck: { title, slug, source, pages, slides, dir } (plus truncated when part of the input
// is not in the deck), also written to <dir>/deck.json. pageWidth (page picture width in px) is passed through to
// buildPdfDeck for PDF and office inputs. Without a slug, deckSlug picks one that no other source's deck holds.
// signal (an AbortSignal) cancels the build: Chrome is closed, LibreOffice killed, and a cancelled build never
// replaces the deck already there (a PDF's pages already being rendered by buildPdfDeck still finish first).
// deadlineMs bounds a web page's capture (default 90 s).
export async function buildDeck(input, { slidesRoot, slug, title, fit, maxPages = 60, pageWidth, signal, deadlineMs } = {}) {
  if (!slidesRoot) throw new Error('slidesRoot is required');
  if (fit !== undefined && fit !== 'page' && fit !== 'width') throw new Error(`fit must be 'page' or 'width', not ${JSON.stringify(fit)}`);
  const target = await classify(input);
  const chosenSlug = slug ?? await deckSlug(slidesRoot, input);
  assertSafeSlug(chosenSlug); // before any conversion, so a bad slug fails fast and wipes nothing
  if (signal?.aborted) throw cancelled();
  const chosenFit = fit || (target.kind === 'presentation' ? 'page' : 'width');
  const options = { slidesRoot, slug: chosenSlug, title, fit: chosenFit, maxPages, pageWidth, signal };
  try {
    if (target.kind === 'pdf') return await buildFromPdf(target.given, { ...options, source: target.given });
    if (target.kind === 'presentation' || target.kind === 'document') {
      const { pdf, cleanup } = await officeToPdf(target.file, OFFICE_TIMEOUT_MS, signal);
      try { return await buildFromPdf(pdf, { ...options, source: target.given }); } finally { await cleanup(); }
    }
    if (target.kind === 'web') return await buildWebDeck(target, { ...options, ...(deadlineMs ? { deadlineMs } : {}) });
    return await buildImageDeck(target.file, { ...options, source: target.given });
  } catch (error) {
    throw signal?.aborted ? cancelled() : error;
  }
}
