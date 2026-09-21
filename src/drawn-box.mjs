// The rectangle the stage actually PAINTS for a highlight, in page-normalized units.
// src/pointer.mjs resolves a phrase to a box and pads it (HIGHLIGHT_PAD, then PAD_PX screen-scaled); src/meet-stage.js
// then pads that box by a further 14 canvas pixels per side when it strokes the amber rounded rectangle. So the box a
// viewer sees is strictly larger than the box that was resolved, and by different amounts in x and y, because a
// fit-width view is a wide crop stretched onto a 16:9 stage. Anything that reports "what is highlighted" from the
// resolved box is reporting a rectangle that is not on screen. This projects the resolved box through exactly the
// same arithmetic the stage uses, so the answer is the rectangle that is really painted. Pure. One job.
export const STAGE_W = 1920;
export const STAGE_H = 1080;
export const DRAW_PAD_PX = 14; // meet-stage.js drawHighlight: `const pad = 14`

// The stage's map for a settled frame: { ox, oy, sx, sy } taking page-normalized coordinates to canvas pixels.
// `asset` is the pixel size of the view's exact render ({ width, height }) when it has one; otherwise `page` is the
// pixel size of the whole-page render and the stage crops it (drawCamera).
export function stageMap({ rect, asset = null, page = null, stageW = STAGE_W, stageH = STAGE_H }) {
  const rw = Number.isFinite(rect?.w) && rect.w > 0 ? rect.w : 1;
  const rh = Number.isFinite(rect?.h) && rect.h > 0 ? rect.h : 1;
  let dw, dh;
  if (asset?.width > 0 && asset?.height > 0) {
    // paintSettled: a pixel-exact render of this view, drawn 1:1 when it matches the stage, otherwise fitted.
    const scale = Math.min(stageW / asset.width, stageH / asset.height);
    dw = asset.width * scale;
    dh = asset.height * scale;
  } else if (page?.width > 0 && page?.height > 0) {
    // drawCamera: crop the whole-page render to the view rectangle, then fit.
    const sw = rw * page.width, sh = rh * page.height;
    const scale = Math.min(stageW / sw, stageH / sh);
    dw = sw * scale;
    dh = sh * scale;
  } else { dw = stageW; dh = stageH; }
  return { ox: (stageW - dw) / 2, oy: (stageH - dh) / 2, sx: dw / rw, sy: dh / rh, rect: { ...rect, w: rw, h: rh } };
}

// The painted rectangle in canvas pixels, exactly as drawHighlight strokes it.
export function paintedPixels(map, box, pad = DRAW_PAD_PX) {
  if (!map || !box) return null;
  return {
    x: map.ox + (box.x - map.rect.x) * map.sx - pad,
    y: map.oy + (box.y - map.rect.y) * map.sy - pad,
    w: box.w * map.sx + pad * 2,
    h: box.h * map.sy + pad * 2,
  };
}

// The painted rectangle back in page-normalized units, so it can be compared with word and line boxes.
export function paintedBox({ rect, box, asset = null, page = null, pad = DRAW_PAD_PX, stageW = STAGE_W, stageH = STAGE_H }) {
  if (!box) return null;
  const map = stageMap({ rect, asset, page, stageW, stageH });
  const padX = pad / map.sx, padY = pad / map.sy;
  return { x: box.x - padX, y: box.y - padY, w: box.w + padX * 2, h: box.h + padY * 2, padX, padY, map };
}

// Pixel size of a PNG from its header, without decoding it. The stage needs the render's aspect to place a box.
export function pngSize(bytes) {
  if (!bytes || bytes.length < 24) return null;
  const view = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (view.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
}
