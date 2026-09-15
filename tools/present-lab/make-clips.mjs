// Spoken clips for the live presentation test (the observer "interrupts" the narration, then says continue).
// OpenAI TTS; the key is read the way the app reads it and is never printed.
import { writeFileSync } from 'node:fs';
import { readApiKey } from '../../src/live.mjs';
const key = readApiKey();
if (!key) { console.error('no key'); process.exit(1); }
const here = new URL('.', import.meta.url).pathname;
const phrases = { interrupt: 'Wait, what does that equation mean?', continue: 'Okay, continue.' };
for (const [name, input] of Object.entries(phrases)) {
  const response = await fetch('https://api.openai.com/v1/audio/speech', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'alloy', input, response_format: 'wav' }) });
  if (!response.ok) { console.error(name, 'HTTP', response.status, (await response.text()).replace(/sk-[\w-]+/g, '[redacted]').slice(0, 200)); process.exit(1); }
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(`${here}clips/${name}.wav`, bytes);
  console.log(name, bytes.length, 'bytes');
}
