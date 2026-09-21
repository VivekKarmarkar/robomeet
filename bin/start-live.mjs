#!/usr/bin/env node
// Launcher that can run either voice path: ROBOMEET_VOICE_IN_PAGE=1 selects single-hop (GPT Live inside the Meet page);
// unset, it behaves exactly like bin/start.mjs.
// Identical to bin/start.mjs except that ROBOMEET_VOICE_IN_PAGE=1 selects the single-hop worker.
// bin/attend.mjs reuses an already-running server (its ensureServer() returns as soon as GET /api/state answers),
// so start this first with attend's environment, then run attend.mjs as usual; see attend-live.sh.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { selectWorkerFactory, voiceInPage } from '../src/voice-in-page.mjs';
import { watchPointerTruth } from '../src/screen-truth.mjs';
import { startScreenFeed } from '../src/screen-feed.mjs';
import { wordsForDeck } from '../src/word-boxes.mjs';
const app = await createApp({ workerFactory: await selectWorkerFactory() });
// The robot cannot see its own shared screen, so on 2026-09-19 it drew a box around two velocity components and told
// the person it had boxed one. This tells it what the box really holds, on the thinking channel, whenever one is
// drawn. Off the pointer's own path: a failure here cannot stop a highlight. ROBO_SCREEN_TRUTH=0 disables it.
const publicDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'public');
const unwatchTruth = process.env.ROBO_SCREEN_TRUTH === '0' ? null : watchPointerTruth({ store: app.store, live: app.live, publicDir });
// The visual feed. GPT Live takes audio and text only, so the feed is text: a frame loop that samples the screen,
// sends what changed, and drops identical frames. ROBO_SCREEN_FPS=0 disables it.
const fps = Number(process.env.ROBO_SCREEN_FPS ?? 10);
const feed = fps > 0 ? startScreenFeed({ store: app.store, live: app.live, fps, wordsFor: slug => wordsForDeck(publicDir, slug).catch(() => null) }) : null;
console.log(`Robomeet${voiceInPage() ? ' (single-hop voice in the Meet page)' : ''}${unwatchTruth ? ' [screen truth on]' : ''}${feed ? ` [screen feed ${fps}fps]` : ''}: ${app.baseUrl}`);
let stopping = false;
async function stop() { if (stopping) return; stopping = true; feed?.stop(); unwatchTruth?.(); await app.close(); process.exit(0); }
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
