// Worker-mode flag for single-hop voice.
// ROBOMEET_VOICE_IN_PAGE=1 selects the single-hop worker (GPT Live WebRTC inside the Meet page);
// anything else returns undefined so src/server.mjs createApp() loads the default src/meet-worker.mjs.
export const voiceInPage = (env = process.env) => env.ROBOMEET_VOICE_IN_PAGE === '1';
export async function selectWorkerFactory(env = process.env) {
  if (!voiceInPage(env)) return undefined;
  return (await import('./meet-worker-live.mjs')).createSingleHopWorker;
}
