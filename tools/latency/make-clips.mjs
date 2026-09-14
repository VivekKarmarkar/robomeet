// Generate short spoken clips with OpenAI TTS (natural voice, so GPT Live's turn detection treats them as speech).
// The key is read the same way the app reads it; it is never printed.
import { writeFileSync } from 'node:fs';
import { readApiKey } from '../../src/live.mjs';
const key = readApiKey();
if (!key) { console.error('no key'); process.exit(1); }
const phrases = {
  hello: 'Hello?',
  hear: 'Hello, can you hear me?',
  who: 'Who are you?',
  session: 'What is the name of the session you are connected to?',
  bye: 'Okay, thanks. Bye.',
  delegate: 'Vivek Bot, please ask the coding agent to count the files in the project.',
  stillthere: 'Are you still there?',
};
for (const [name, input] of Object.entries(phrases)) {
  const r = await fetch('https://api.openai.com/v1/audio/speech', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'alloy', input, response_format: 'wav' }) });
  if (!r.ok) { console.error(name, 'HTTP', r.status, (await r.text()).replace(/sk-[\w-]+/g, '[redacted]').slice(0, 200)); process.exit(1); }
  const bytes = Buffer.from(await r.arrayBuffer());
  writeFileSync(`clips/${name}.wav`, bytes);
  console.log(name, bytes.length, 'bytes');
}
