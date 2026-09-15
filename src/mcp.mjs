import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPdfDeck } from './deck-builder.mjs'; // stage: PDFs become scrolling decks with exact view renders
import { buildDeck, deckSlug, DECK_SLUG } from './deck-formats.mjs'; // stage: presentations, documents, web pages, pictures

// stage: decks live in the app's own public/slides (the server reads them there), never relative to ROBO_DATA_DIR.
const SLIDES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../public/slides');
const NEXT = 'Move with the stage tool {slide, view}. For a narrated walk, call narrate with beats [{slide, view, say}] written only from each view\'s visible text.';
// stage: what a built deck shows, view by view, capped so a long document never floods the coding session (the full
// text is in deck.json). A deck that reached maxPages says so instead of cutting the document silently.
const LISTED_VIEWS = 120; // beyond this the result lists no more views (a 200-page document would be ~130 KB)
function deckReport(deck, slug, maxPages) {
  const all = deck.slides.flatMap((slide, s) => slide.views.map((view, v) => ({ slide: s, view: v, page: s + 1, part: `${v + 1}/${slide.views.length}`, text: (view.lines || []).map(line => typeof line === 'string' ? line : line.text).join(' | ') })));
  const listed = all.slice(0, LISTED_VIEWS);
  const each = Math.max(100, Math.min(900, Math.floor(24000 / Math.max(1, listed.length))));
  const views = listed.map(({ text, ...rest }) => ({ ...rest, visible: text.length > each ? `${text.slice(0, each)}...` : text }));
  const more = all.length > listed.length ? { moreViews: `${all.length - listed.length} more views are not listed here; their text is in fullText.` } : {};
  const atLimit = deck.truncated?.reason === 'maxPages' || (!deck.truncated && deck.pages >= maxPages);
  const limit = atLimit ? { pageLimit: `Stopped at ${maxPages} pages${deck.truncated?.totalPages ? ` of ${deck.truncated.totalPages}` : '; the document may have more'}.${maxPages < 200 ? ' Call again with a larger maxPages (up to 200) to include them.' : ' 200 is the most a deck can have.'}` } : {};
  const cut = deck.truncated ? { truncated: deck.truncated } : {}; // e.g. a web page longer than the capture
  return { presented: deck.pages, slug, title: deck.title, views, ...more, fullText: `public/slides/${slug}/deck.json`, ...limit, ...cut, next: NEXT };
}
// A deck built after the client gave up (timeout, cancel) is not put on the shared screen.
const stillWanted = extra => { if (extra?.signal?.aborted) throw new Error('Cancelled: the deck was built but not presented.'); };

export function createMcp({ baseUrl = process.env.ROBO_URL || 'http://127.0.0.1:4318', dataDir = process.env.ROBO_DATA_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '../data'), fetchImpl = fetch } = {}) {
  const parsed = new URL(baseUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new Error('The Robomeet MCP bridge only connects to localhost.');
  const server = new McpServer({ name: 'robomeet', version: '0.1.0' });
  const request = async (path, payload, signal) => {
    let token;
    try { token = readFileSync(join(dataDir, 'control-token'), 'utf8').trim(); }
    catch { throw new Error('Start the local Robomeet app first.'); }
    const response = await fetchImpl(new URL(path, baseUrl), { method: payload ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}), signal });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `Robomeet returned HTTP ${response.status}`);
    if (path === '/api/state' || path === '/api/command') {
      delete value.events;
      // stage: a deck's per-view visible text and narration can be large; keep them out of every tool result.
      if (Array.isArray(value.slides)) value.slides = value.slides.map(slide => (Array.isArray(slide.views) ? { ...slide, views: slide.views.map(({ lines, blocks, ...view }) => ({ ...view, ...(view.say ? { say: `${String(view.say).slice(0, 80)}${String(view.say).length > 80 ? '...' : ''}` } : {}) })) } : slide));
      if (Array.isArray(value.jobs)) {
        const recentCompleted = new Set(value.jobs.filter(job => job.status === 'completed').slice(-10).map(job => job.id));
        value.jobs = value.jobs.filter(job => job.status !== 'completed' || recentCompleted.has(job.id));
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify(value) }] };
  };
  const tool = (name, description, inputSchema, fn) => server.registerTool(name, { description, inputSchema }, async (args, extra) => {
    try { return await fn(args, extra); } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  tool('status', 'Read the robot meeting, voice, presentation, notes and pending task state.', {}, () => request('/api/state'));
  tool('join', 'Join a Google Meet invitation as the robot. Voice starts only after a separate explicit command in the app.', { url: z.string().url(), name: z.string().max(80).optional() }, args => request('/api/command', { type: 'join', ...args }));
  tool('leave', 'Stop the voice session and leave the meeting.', {}, () => request('/api/command', { type: 'leave' }));
  tool('voice', 'Explicitly start or stop GPT Live voice. Starting uses the configured paid API after meeting admission. preview is only for a local microphone preview.', { enabled: z.boolean(), preview: z.boolean().default(false) }, args => request('/api/command', { type: args.enabled ? 'voice-start' : 'voice-stop', preview: args.preview }));
  tool('mode', 'Set quiet (input and output muted), listen (listen silently), or speak (respond when addressed).', { mode: z.enum(['quiet', 'listen', 'speak']) }, args => request('/api/command', { type: 'mode', ...args }));
  tool('slide', 'Select a slide by its zero-based index.', { index: z.number().int().nonnegative() }, args => request('/api/command', { type: 'slide', ...args }));
  tool('listen', 'Wait for actionable durable events and coding-agent requests. Transcript chunks are excluded by default to avoid waking the coding agent for every spoken fragment. Add transcript to types to opt in. Save and reuse the returned cursor. This does not independently wake an idle desktop conversation.', { after: z.number().int().nonnegative().default(0), timeoutMs: z.number().int().min(0).max(50000).default(50000), types: z.array(z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/)).max(30).default(['agent.request', 'agent.result', 'note.added', 'meeting.status', 'voice.closed', 'voice.error']) }, (args, extra) => request(`/api/listen?after=${args.after}&timeout=${args.timeoutMs}&types=${encodeURIComponent(args.types.join(','))}`, null, extra.signal));
  tool('reply', 'Complete a pending coding-agent job by its exact ID. Results are durable and routed only to the original live session.', { jobId: z.string(), result: z.string().min(1).max(32000) }, args => request('/api/command', { type: 'reply', ...args }));
  tool('send_context', 'Set reference context for the meeting and send it quietly to an active voice session.', { text: z.string().min(1).max(16000) }, args => request('/api/command', { type: 'context', ...args }));
  tool('present', 'Display plain-text slides on the robot. Optionally request the browser screenshare using enabled.', { title: z.string().max(300).default(''), slides: z.array(z.object({ title: z.string().max(300), body: z.string().max(5000) })).max(400), enabled: z.boolean().optional() }, args => request('/api/command', { type: 'present', ...args }));
  // stage: a PDF becomes a deck: each page is one slide with fit-to-width views that the shared screen scrolls through
  // (next/previous/stage move between them); every view has a pixel-exact render. The result lists what each view
  // shows so narration can be written against exactly what is visible.
  tool('present_pdf', 'Present a PDF on the robot\'s shared screen as a scrolling document: every page becomes a slide with fit-to-width views (screen-sized parts, top to bottom) rendered pixel-exact at 1920x1080. Returns, for every view, the text visible in it. Give the absolute path of the PDF on this machine. enabled true also starts sharing in the meeting.', { path: z.string().min(1).max(1000), title: z.string().max(300).optional(), maxPages: z.number().int().min(1).max(200).default(60), enabled: z.boolean().optional() }, async (args, extra) => {
    const slug = await deckSlug(SLIDES_ROOT, args.path); // reuses the slug of the same file, never another document's
    const deck = /\.pdf$/i.test(args.path)
      ? await buildDeck(args.path, { slidesRoot: SLIDES_ROOT, slug, title: args.title, maxPages: args.maxPages, signal: extra?.signal })
      : await buildPdfDeck(args.path, { slidesRoot: SLIDES_ROOT, slug, title: args.title, maxPages: args.maxPages });
    stillWanted(extra);
    await request('/api/command', { type: 'present-deck', slug, ...(args.enabled === undefined ? {} : { enabled: args.enabled }) });
    return { content: [{ type: 'text', text: JSON.stringify(deckReport(deck, slug, args.maxPages)) }] };
  });
  // stage: any document a person would share: slides and documents via LibreOffice, web pages via Chrome, pictures.
  tool('present_file', 'Present a document on the robot\'s shared screen the way a person shares their screen: a PDF, a presentation (.pptx .ppt .odp; export Keynote to PDF or .pptx first), a document (.docx .doc .odt .rtf), a web page (.html file or an http(s) URL), or a picture (.png .jpg .webp). Every page or slide is rendered pixel-exact at 1920x1080. fit page shows each slide or page whole (the default for presentations); fit width scrolls screen-sized parts top to bottom (the default for everything else). Returns, for every view, the text visible in it. Give an absolute path on this machine or a URL. enabled true also starts sharing in the meeting.', { path: z.string().min(1).max(2000), title: z.string().max(300).optional(), fit: z.enum(['page', 'width']).optional(), maxPages: z.number().int().min(1).max(200).default(60), enabled: z.boolean().optional() }, async (args, extra) => {
    const slug = await deckSlug(SLIDES_ROOT, args.path);
    const deck = await buildDeck(args.path, { slidesRoot: SLIDES_ROOT, slug, title: args.title, fit: args.fit, maxPages: args.maxPages, signal: extra?.signal });
    stillWanted(extra);
    await request('/api/command', { type: 'present-deck', slug, ...(args.enabled === undefined ? {} : { enabled: args.enabled }) });
    return { content: [{ type: 'text', text: JSON.stringify(deckReport(deck, slug, args.maxPages)) }] };
  });
  tool('present_deck', 'Present a deck already built with bin/deck.mjs (public/slides/<slug>/deck.json), including any narration written into its views. enabled true also starts sharing.', { slug: z.string().regex(DECK_SLUG), enabled: z.boolean().optional() }, args => request('/api/command', { type: 'present-deck', ...args }));
  tool('stage', 'Move the shared screen to a slide and one of its views (a PDF page scrolls or zooms smoothly to that part). Zero-based indexes; view defaults to 0.', { slide: z.number().int().nonnegative().optional(), view: z.number().int().nonnegative().optional() }, args => request('/api/command', { type: 'stage', ...args }));
  tool('narrate', 'Run a narrated presentation: for each beat RoboMeet moves the shared screen to that view first, then the robot presents it, then the next beat. Write each say only from what that view shows (present_pdf returns the visible text). The robot holds when someone talks and continues when someone says continue or next. style own-words (default) lets the robot phrase it; verbatim asks it to say the text as written. Returns at once; follow progress with listen types presenter.started, presenter.beat, presenter.beat_done, presenter.paused, presenter.resumed, presenter.moved, presenter.done, presenter.stopped, presenter.error.', { beats: z.array(z.object({ slide: z.number().int().nonnegative(), view: z.number().int().nonnegative(), say: z.string().min(1).max(900) })).max(400).optional(), from: z.number().int().nonnegative().optional(), style: z.enum(['own-words', 'verbatim']).optional() }, args => request('/api/command', { type: 'narrate', ...args }));
  tool('presenter', 'Control a running narrated presentation: pause, resume, next, previous, stop, or goto (with beat, zero-based).', { action: z.enum(['pause', 'resume', 'next', 'previous', 'stop', 'goto']), beat: z.number().int().nonnegative().optional() }, args => request('/api/command', { type: 'presenter', ...args }));
  tool('say', 'Have the robot speak a short sentence aloud now in the meeting (requires an active voice session). Use for announcements or spoken status; the model may lightly paraphrase.', { text: z.string().min(1).max(600) }, args => request('/api/command', { type: 'announce', ...args }));
  tool('notes', 'Read the meeting notes, or append one note when text is provided.', { text: z.string().min(1).max(16000).optional() }, args => args.text ? request('/api/command', { type: 'note', text: args.text }) : request('/api/state'));
  return server;
}
export async function startMcp() { const server = createMcp(); await server.connect(new StdioServerTransport()); return server; }
