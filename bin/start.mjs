#!/usr/bin/env node
import { createApp } from '../src/server.mjs';
const app = await createApp();
console.log(`Robomeet: ${app.baseUrl}`);
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await app.close(); process.exit(0); }
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
