// TC-V7: the picture path. gpt-live-1 cannot be shown a picture ("Unsupported modalities: image, video"), so the
// only route is the delegated backend, via `response.item.create` carrying an `input_image`. The bytes ride as a
// Files API id, not inline, because that event carries the session's small backend history. Nothing here calls
// OpenAI: the upload is driven through an injected fetch so the wire shape is asserted, not assumed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dataUrlToBuffer, cropRect, cropImage, pngSizeOf } from '../src/stage-shot.mjs';
import { uploadVisionFile, imageItem, imageItemEvent, highlightQuestion, UNTRUSTED, DEFAULT_DETAIL } from '../src/vision-check.mjs';

const ASSET = new URL('../public/slides/projectile-motion-deck/page-1-view-1.png', import.meta.url);

test('TC-V7: a stage snapshot data URL becomes bytes; anything else is refused', async () => {
  const bytes = await readFile(ASSET);
  const url = `data:image/png;base64,${bytes.toString('base64')}`;
  const back = dataUrlToBuffer(url);
  assert.equal(back.mime, 'image/png');
  assert.ok(back.bytes.equals(bytes), 'the bytes survive the round trip');
  assert.deepEqual(pngSizeOf(back.bytes), { width: 1920, height: 1080 });
  for (const bad of ['', null, 'data:text/plain;base64,aGk=', 'https://example.com/a.png']) assert.equal(dataUrlToBuffer(bad), null);
});

test('TC-V7: the crop is clamped to the frame and never inverted', () => {
  const frame = { width: 1920, height: 1080 };
  const middle = cropRect({ x: 900, y: 500, w: 100, h: 40 }, { ...frame, pad: 48 });
  assert.ok(middle.x >= 0 && middle.y >= 0 && middle.x + middle.w <= 1920 && middle.y + middle.h <= 1080);
  assert.equal(middle.w % 2, 0, 'even width'); assert.equal(middle.h % 2, 0, 'even height');
  const corner = cropRect({ x: 4, y: 4, w: 20, h: 10 }, { ...frame, pad: 48 });
  assert.equal(corner.x, 0); assert.equal(corner.y, 0);
  const far = cropRect({ x: 1900, y: 1060, w: 100, h: 100 }, { ...frame, pad: 48 });
  assert.ok(far.x + far.w <= 1920 && far.y + far.h <= 1080, 'clamped at the far edge');
  assert.equal(cropRect(null, frame), null);
  assert.equal(cropRect({ x: 0, y: 0, w: 10, h: 10 }, { width: 0, height: 0 }), null);
});

test('TC-V7: a small box is cropped AND enlarged, because the vision guide says to enlarge small text', async () => {
  const bytes = await readFile(ASSET);
  const out = await cropImage(bytes, { x: 1238, y: 551, w: 204, h: 54 });
  const size = pngSizeOf(out.bytes);
  assert.ok(out.scale > 1, 'a 300px-wide crop is upscaled');
  assert.ok(size.width >= 768, `${size.width}px wide is readable`);
  assert.ok(size.width < 1920 && size.height < 1080, 'and it is still a crop, not the whole frame');
  assert.ok(out.bytes.length < bytes.length, 'smaller than the full frame');
  const whole = await cropImage(bytes, null);
  assert.deepEqual(pngSizeOf(whole.bytes), { width: 1920, height: 1080 }, 'no rect means the whole frame');
});

test('TC-V7: the image rides as a file id inside response.item.create, not as inline bytes', () => {
  const event = imageItemEvent({ fileId: 'file-abc', question: 'what is in the box?' });
  assert.equal(event.type, 'response.item.create', 'the Live event for the Responses backend');
  assert.equal(event.item.role, 'user');
  const [text, image] = event.item.content;
  assert.equal(text.type, 'input_text');
  assert.equal(image.type, 'input_image');
  assert.equal(image.file_id, 'file-abc');
  assert.equal(image.image_url, undefined, 'no inline data URL: the event carries the small backend history');
  assert.equal(image.detail, DEFAULT_DETAIL);
  assert.ok(Buffer.byteLength(JSON.stringify(event)) < 4096, 'the whole event is small');
  // A shared document can contain words that read like orders; they are data.
  assert.ok(text.text.startsWith(UNTRUSTED), 'every image carries the untrusted-data guard');
  assert.throws(() => imageItem({ fileId: '' }), /No file id/);
});

test('TC-V7: the upload asks the Files API for a vision file and returns its id', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ id: 'file-xyz' }) }; };
  const id = await uploadVisionFile(Buffer.from([1, 2, 3]), { apiKey: 'sk-test-SENTINEL', fetchImpl, filename: 'crop.png' });
  assert.equal(id, 'file-xyz');
  assert.equal(calls[0].url, 'https://api.openai.com/v1/files');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body.get('purpose'), 'vision');
  assert.ok(calls[0].options.body.get('expires_after[seconds]'), 'uploads expire on their own');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-test-SENTINEL', 'the key goes in the header, nowhere else');
  assert.ok(!JSON.stringify([...calls[0].options.body.keys()]).includes('SENTINEL'), 'and never into the form body');
  await assert.rejects(() => uploadVisionFile(Buffer.from([1]), { apiKey: '', fetchImpl }), /No API key/);
  await assert.rejects(() => uploadVisionFile(Buffer.alloc(0), { apiKey: 'k', fetchImpl }), /No image bytes/);
  await assert.rejects(() => uploadVisionFile(Buffer.from([1]), { apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 413, text: async () => '' }) }), /HTTP 413/);
});

test('TC-V7: the question asks the backend to read, and invites it to contradict the robot', () => {
  const q = highlightQuestion({ expect: 'ẏ(0) = v 0 sin θ', claim: 'I boxed only the vertical velocity.' });
  for (const line of ['BOX:', 'INSIDE:', 'EDGE:']) assert.ok(q.includes(line), `${line} is requested`);
  assert.match(q, /do not agree to be agreeable/, 'the backend is told not to rubber-stamp');
  assert.match(q, /Contradict it if the picture does not support it/);
  assert.ok(!highlightQuestion().includes('believes'), 'with no expectation it states none');
});
