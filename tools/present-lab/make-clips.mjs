// Spoken clips for the live presentation test (the observer "interrupts" the narration, then says continue).
// OpenAI TTS; the key is read the way the app reads it and is never printed.
import { writeFileSync } from 'node:fs';
import { readApiKey } from '../../src/live.mjs';
const key = readApiKey();
if (!key) { console.error('no key'); process.exit(1); }
const here = new URL('.', import.meta.url).pathname;
import { existsSync } from 'node:fs';
const phrases = { interrupt: 'Wait, what does that equation mean?', continue: 'Okay, continue.',
  // P1 and P3 (docs/problems/presenting-v1.md)
  delegate: 'Please ask the coding agent to count how many test files the RoboMeet project has.',
  question: 'While we wait, which company makes your voice model?',
  point: 'Can you point at equation three on your screen?',
  help: 'Quick question: when you do not know something, where can you get help?' };
for (const [name, input] of Object.entries(phrases)) {
  if (existsSync(`${here}clips/${name}.wav`)) continue; // keep the clips earlier runs were measured with
  const response = await fetch('https://api.openai.com/v1/audio/speech', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'alloy', input, response_format: 'wav' }) });
  if (!response.ok) { console.error(name, 'HTTP', response.status, (await response.text()).replace(/sk-[\w-]+/g, '[redacted]').slice(0, 200)); process.exit(1); }
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(`${here}clips/${name}.wav`, bytes);
  console.log(name, bytes.length, 'bytes');
}
