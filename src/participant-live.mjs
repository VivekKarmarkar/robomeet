// A second meeting participant whose voice is a persona, not RoboMeet: the simulated human for live tests.
//
// It is a LiveManager like the robot's, with one difference: the request that creates the GPT Live session is
// rewritten on its way out, so the session gets the persona's instructions and voice, and a backend with no tools.
// Nothing in src/live.mjs changes; the POST body is { session, transport } (src/live.mjs create) and only the
// `session` part is replaced. Every other request passes through untouched. One job.
import { LiveManager } from './live.mjs';

const CREATE = 'https://api.openai.com/v1/live/sessions';

export function personaFetch(baseFetch, { instructions, voice = 'cedar', backend = 'gpt-5.6-luna' }) {
  return async (url, options = {}) => {
    if (String(url) === CREATE && options.method === 'POST' && typeof options.body === 'string') {
      const body = JSON.parse(options.body);
      const session = body.session || {};
      body.session = {
        ...session,
        instructions,
        audio: { ...(session.audio || {}), output: { ...(session.audio?.output || {}), voice } },
        // A persona must never act in the meeting: no notes, no slides, no pointing. It only talks.
        delegation: { type: 'responses', responses: { model: backend, instructions: 'Never call tools.', tools: [], tool_choice: 'none' } },
      };
      options = { ...options, body: JSON.stringify(body) };
    }
    return baseFetch(url, options);
  };
}

export function participantLiveFactory({ instructions, voice, backend, maxDurationMs = 3600000 } = {}) {
  return deps => new LiveManager({ ...deps, fetchImpl: personaFetch(fetch, { instructions, voice, backend }), maxDurationMs });
}
