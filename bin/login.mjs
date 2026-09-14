#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { prepareBrowserProfile } from '../src/browser-profile.mjs';

try {
  const profile = await prepareBrowserProfile(process.env.ROBOMEET_PROFILE_DIR);
  const signIn = new URL('https://accounts.google.com/ServiceLogin');
  signIn.searchParams.set('Email', 'vivekkmk.assistant@gmail.com');
  signIn.searchParams.set('continue', 'https://meet.google.com/');
  console.log('Opening normal Chrome for RoboMeet. Sign in with vivekkmk.assistant@gmail.com, then close this Chrome window.');
  console.log(`Dedicated profile: ${profile}`);
  const child = spawn(process.env.ROBOMEET_CHROME_PATH || '/usr/bin/google-chrome', [
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--new-window', signIn.href,
  ], {
    env: { ...process.env, DISPLAY: process.env.ROBOMEET_DISPLAY || process.env.DISPLAY || ':1' },
    stdio: 'inherit',
  });
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  process.exitCode = code;
  if (code === 0) console.log('Chrome closed. Start RoboMeet with ROBOMEET_PROFILE_DIR set to the same dedicated profile.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
