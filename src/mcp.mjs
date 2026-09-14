import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPdfSlides } from './pdf-slides.mjs';

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
  tool('present_pdf', 'Present a PDF in the meeting: every page becomes a picture slide on the robot shared screen. Give the absolute path of the PDF on this machine. Optionally request the screenshare with enabled.', { path: z.string().min(1).max(1000), title: z.string().max(300).optional(), maxPages: z.number().int().min(1).max(400).default(400), enabled: z.boolean().optional() }, async args => {
    const { slug, pages, slides } = await renderPdfSlides(args.path, { slidesRoot: resolve(dataDir, '../public/slides'), maxPages: args.maxPages });
    const result = await request('/api/command', { type: 'present', title: args.title || slug, slides, ...(args.enabled === undefined ? {} : { enabled: args.enabled }) });
    return { content: [{ type: 'text', text: JSON.stringify({ presented: pages, slug, ...(JSON.parse(result.content[0].text).meeting ? {} : {}) }) }] };
  });
  tool('say', 'Have the robot speak a short sentence aloud now in the meeting (requires an active voice session). Use for announcements or spoken status; the model may lightly paraphrase.', { text: z.string().min(1).max(600) }, args => request('/api/command', { type: 'announce', ...args }));
  tool('notes', 'Read the meeting notes, or append one note when text is provided.', { text: z.string().min(1).max(16000).optional() }, args => args.text ? request('/api/command', { type: 'note', text: args.text }) : request('/api/state'));
  return server;
}
export async function startMcp() { const server = createMcp(); await server.connect(new StdioServerTransport()); return server; }
