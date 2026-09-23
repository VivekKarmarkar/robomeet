// What a person in the meeting actually SEES on the robot's shared screen: the robot's own src/meet-stage.js,
// run in a headless page, fed the real deck, the real view renders and the real box, and asked for its own
// snapshot() — the pre-encode picture Meet receives. Not a reproduction of the stage: the stage itself.
//
// Also finds the amber box in those pixels by colour, so a claim about the box ("it clips the next term") can be
// checked against the picture, not against the arithmetic that produced it. One job: the picture, and the box in it.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const { chromium } = createRequire(join(ROOT, 'package.json'))('playwright');

export async function createStageEyes({ publicDir = join(ROOT, 'public'), chrome = process.env.ROBOMEET_CHROME_PATH || '/usr/bin/google-chrome' } = {}) {
  const browser = await chromium.launch({ headless: true, executablePath: chrome });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.route('https://stage.test/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body></body></html>' }));
  await page.addInitScript({ path: join(ROOT, 'src', 'meet-stage.js') });
  await page.goto('https://stage.test/');
  await page.waitForFunction(() => Boolean(window.RoboMeetStage));
  const loaded = new Set();
  async function asset(id) {
    if (!id || loaded.has(id)) return;
    const bytes = await readFile(join(publicDir, id.replace(/^\//, '')));
    await page.evaluate(([i, data]) => window.RoboMeetStage.putAsset(i, new Uint8Array(data), 'image/png'), [id, [...bytes]]);
    loaded.add(id);
  }
  // state: the server's store state (slides with views, slideIndex, viewIndex; a view may carry a highlight).
  async function frame(state) {
    const slides = (state.slides || []).map(slide => ({
      kind: 'image', asset: slide.asset || slide.views?.[0]?.asset || null, title: slide.title || '', body: '',
      views: (slide.views || []).map(v => ({ x: v.x, y: v.y, w: v.w, h: v.h, asset: v.asset || null, highlight: v.highlight || null })),
    }));
    const slide = Number(state.slideIndex) || 0, view = Number(state.viewIndex) || 0;
    const v = slides[slide]?.views?.[view];
    for (const id of [slides[slide]?.asset, v?.asset]) await asset(id);
    await page.evaluate(deck => window.RoboMeetStage.setDeck(deck), { title: state.title || '', slides });
    await page.evaluate(pos => window.RoboMeetStage.show(pos), { slide, view, transitionMs: 0 });
    await page.waitForTimeout(500); // the box fades in over 320 ms
    const url = await page.evaluate(() => window.RoboMeetStage.snapshot('image/png'));
    return Buffer.from(url.split(',')[1], 'base64');
  }
  // The painted amber box, found by colour in a frame: { x, y, w, h } of its OUTER stroke edge in canvas px, or null.
  async function findBox(png) {
    return page.evaluate(async b64 => {
      const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(img.width, img.height), g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, img.width, img.height).data;
      let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, n = 0;
      for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4, r = d[i], gg = d[i + 1], bb = d[i + 2];
        // the stroke is #f9ab00; accept its anti-aliased edge but not the faint 10% fill or the glow
        if (r > 200 && gg > 130 && gg < 200 && bb < 80) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      return n < 40 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, pixels: n };
    }, png.toString('base64'));
  }
  return { frame, findBox, close: () => browser.close() };
}
