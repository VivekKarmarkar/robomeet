#!/usr/bin/env node
// Launcher that can run either voice path: ROBOMEET_VOICE_IN_PAGE=1 selects single-hop (GPT Live inside the Meet page);
// unset, it behaves exactly like bin/start.mjs.
// Identical to bin/start.mjs except that ROBOMEET_VOICE_IN_PAGE=1 selects the single-hop worker.
// bin/attend.mjs reuses an already-running server (its ensureServer() returns as soon as GET /api/state answers),
// so start this first with attend's environment, then run attend.mjs as usual; see attend-live.sh.
import { createApp } from '../src/server.mjs';
import { selectWorkerFactory, voiceInPage } from '../src/voice-in-page.mjs';
const app = await createApp({ workerFactory: await selectWorkerFactory() });
console.log(`Robomeet${voiceInPage() ? ' (single-hop voice in the Meet page)' : ''}: ${app.baseUrl}`);
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await app.close(); process.exit(0); }
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
