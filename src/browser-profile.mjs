import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const dataRoot = resolve(appRoot, 'data');
export const defaultProfileDir = resolve(dataRoot, 'browser-profile');
const marker = '.robomeet-owned-profile';

// Both launchers accept only profiles created for this app, never a user's Chrome profile.
export async function prepareBrowserProfile(requested = defaultProfileDir) {
  const directory = resolve(appRoot, requested);
  const withinData = relative(dataRoot, directory);
  if (!withinData || withinData === '..' || withinData.startsWith(`..${sep}`) || isAbsolute(withinData)) {
    throw new Error('ROBOMEET_PROFILE_DIR must name a dedicated directory inside RoboMeet data/.');
  }
  // Check each existing segment before following it, including the app's data directory.
  let current = appRoot;
  for (const part of ['data', ...withinData.split(sep)]) {
    current = resolve(current, part);
    const info = await lstat(current).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (info?.isSymbolicLink() || (info && !info.isDirectory())) throw new Error('RoboMeet profile directories must be real directories, not symbolic links.');
    if (!info) await mkdir(current, { mode: 0o700 });
  }
  const entries = await readdir(directory);
  if (!entries.includes(marker)) {
    if (entries.length) throw new Error('This directory was not created as a RoboMeet profile. Choose a new empty directory inside data/.');
    await writeFile(resolve(directory, marker), 'RoboMeet dedicated browser profile\n', { flag: 'wx', mode: 0o600 });
  }
  const markerInfo = await lstat(resolve(directory, marker));
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) throw new Error('Invalid RoboMeet profile marker.');
  const lock = await lstat(resolve(directory, 'SingletonLock')).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (lock) throw new Error('The RoboMeet profile is already open or has a Chrome lock. Close its Chrome window before starting another RoboMeet browser.');
  return directory;
}
