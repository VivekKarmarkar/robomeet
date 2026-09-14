#!/usr/bin/env node
// Starts RoboMeet with the signed-in Chrome bridge: the robot joins Meet from the Chrome profile where the
// RoboMeet Bridge extension is loaded (already signed in to Google), so no password or cookie copying is needed.
import { createApp } from '../src/server.mjs';
import { createBridgeMeetingWorker } from '../src/meet-bridge-worker.mjs';
import { bridgeIsStale } from './bridge-build.mjs';

if (bridgeIsStale()) {
  console.warn('RoboMeet Bridge files are missing or older than src/meet-media.js. Run: node bin/bridge-build.mjs');
  console.warn('Then reload the extension on chrome://extensions (or load it once with "Load unpacked").');
}
const app = await createApp({ workerFactory: createBridgeMeetingWorker });
console.log(`Robomeet (signed-in Chrome bridge): ${app.baseUrl}`);
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await app.close(); process.exit(0); }
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
