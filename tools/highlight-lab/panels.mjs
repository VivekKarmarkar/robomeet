// Render the demo panels as 1920x1080 PNGs with headless Chrome, then ffmpeg stitches them into the demo video.
// Chrome rather than ffmpeg drawtext because the panels carry real maths (ẏ, θ, v₀) and drawtext depends on whatever
// glyphs the chosen font happens to have. The deck builder already renders HTML at this size; this reuses that.
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const CHROME = process.env.ROBOMEET_CHROME_PATH || '/usr/bin/google-chrome';
const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
body{width:1920px;height:1080px;background:#12141a;color:#e8eaf0;font:400 30px/1.45 Georgia,'DejaVu Serif',serif;
     display:flex;flex-direction:column;justify-content:center;padding:96px 120px;gap:28px}
.kicker{font:600 24px/1 'DejaVu Sans',sans-serif;letter-spacing:.22em;text-transform:uppercase;color:#f9ab00}
h1{font:700 76px/1.1 Georgia,serif;letter-spacing:-.02em}
h2{font:700 54px/1.15 Georgia,serif}
.sub{font-size:34px;color:#aeb4c2;max-width:1500px}
.quote{border-left:6px solid #f9ab00;padding:20px 0 20px 34px;font-style:italic;font-size:40px;color:#fff;max-width:1560px}
.who{font:600 24px/1 'DejaVu Sans',sans-serif;color:#8d94a5;letter-spacing:.1em;text-transform:uppercase;margin-top:10px}
.bad{color:#ff6b6b;font-weight:700}
.good{color:#51cf66;font-weight:700}
img{max-width:1680px;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.6);align-self:center}
.row{display:flex;gap:30px;align-items:center}
.tag{font:700 26px/1 'DejaVu Sans',sans-serif;padding:12px 22px;border-radius:999px;letter-spacing:.06em}
.tag.bad{background:#3a1416;color:#ff8787}
.tag.good{background:#0f2e18;color:#69db7c}
table{border-collapse:collapse;font:400 34px/1.4 'DejaVu Sans',sans-serif;margin-top:8px}
td,th{padding:16px 34px;text-align:left;border-bottom:1px solid #2a2f3b}
th{font-weight:700;color:#8d94a5;font-size:26px;letter-spacing:.1em;text-transform:uppercase}
td.n{font-variant-numeric:tabular-nums;font-weight:700;font-size:40px}
code{font:400 30px/1.4 'DejaVu Sans Mono',monospace;background:#1c1f28;padding:4px 12px;border-radius:6px}
`;

export async function renderPanels(panels, outDir) {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--disable-blink-features=AutomationControlled', '--force-device-scale-factor=1'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const out = [];
  for (const [i, panel] of panels.entries()) {
    await page.setContent(`<style>${CSS}</style><body>${panel.html}</body>`, { waitUntil: 'load' });
    // setContent leaves the page on about:blank, where a file:// <img> will not load. Pictures are inlined as data
    // URIs by the caller; this waits for them to decode so a panel never screenshots a broken-image icon.
    await page.evaluate(() => Promise.all([...document.images].map(img => img.complete ? null : img.decode().catch(() => null))));
    const broken = await page.evaluate(() => [...document.images].filter(img => !img.naturalWidth).length);
    if (broken) throw new Error(`${broken} picture(s) failed to load in panel ${i}`);
    await page.waitForTimeout(80);
    const file = `${outDir}/panel-${String(i).padStart(2, '0')}.png`;
    await page.screenshot({ path: file });
    out.push({ file, seconds: panel.seconds || 5 });
  }
  await browser.close();
  return out;
}

// Inline a picture so it renders on an about:blank page.
export async function dataUri(path) {
  const { readFile } = await import('node:fs/promises');
  return `data:image/png;base64,${(await readFile(path)).toString('base64')}`;
}
