import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { prepareBrowserProfile } from '../src/browser-profile.mjs';
import { createMeetingWorker } from '../src/meet-worker.mjs';

const dataRoot = fileURLToPath(new URL('../data/', import.meta.url));
const appHtml = `<!doctype html><script>
const audio = new AudioContext();
const destination = audio.createMediaStreamDestination();
const tracks = {audio: destination.stream.getAudioTracks()[0]};
for (const role of ['camera','screen']) {
  const canvas = document.createElement('canvas'); canvas.width=64; canvas.height=64;
  const paint=()=>canvas.getContext('2d').fillRect(0,0,64,64); paint(); setInterval(paint,100);
  tracks[role] = canvas.captureStream(10).getVideoTracks()[0];
}
window.robotApp = {ready: audio.resume(), getOutgoingTracks:()=>tracks, setMeetingInput(){}, stopVoice(){}, setMode(){}};
localStorage.setItem('fixtureVisits', String(Number(localStorage.getItem('fixtureVisits') || 0) + 1));
</script>`;
const meetingHtml = `<!doctype html><input placeholder="Your name"><button id="join">Join now</button><script>
document.querySelector('#join').onclick=()=>{
  document.body.innerHTML='<button id="leave">Leave call</button><button id="present">Present now</button>';
  document.querySelector('#leave').onclick=()=>{document.body.innerText='You left the meeting';};
  document.querySelector('#present').onclick=async()=>{
    const stream=await navigator.mediaDevices.getDisplayMedia({video:true});
    const stop=document.createElement('button'); stop.innerText='Stop presenting';
    stop.onclick=()=>{stream.getTracks().forEach(t=>t.stop());stop.remove();}; document.body.append(stop);
  };
};
</script>`;

async function waitFor(predicate, timeout=15_000) {
  const end=Date.now()+timeout;
  while (Date.now()<end) { if (await predicate()) return; await new Promise(resolve=>setTimeout(resolve,50)); }
  throw new Error('Fixture condition timed out');
}

test('dedicated profile rejects existing or external Chrome directories', async () => {
  await mkdir(dataRoot,{recursive:true});
  const temporary=await mkdtemp(`${dataRoot}meet-profile-test-`);
  try {
    await assert.rejects(prepareBrowserProfile('/tmp/unrelated-chrome'), /inside RoboMeet data/);
    await writeFile(`${temporary}/unrelated-file`, 'fixture');
    await assert.rejects(prepareBrowserProfile(temporary), /new empty directory/);
    await symlink('/tmp', `${temporary}/linked`);
    await assert.rejects(prepareBrowserProfile(`${temporary}/linked/profile`), /symbolic links/);
    const owned=await prepareBrowserProfile(`${temporary}/owned`);
    await symlink('fixture-lock', `${owned}/SingletonLock`);
    await assert.rejects(prepareBrowserProfile(owned), /already open/);
  } finally { await rm(temporary,{recursive:true,force:true}); }
});

test('worker joins, presents and closes in anonymous and dedicated-profile modes', {timeout:60_000}, async () => {
  await mkdir(dataRoot,{recursive:true});
  const temporary=await mkdtemp(`${dataRoot}meet-worker-test-`);
  const originalLaunch=chromium.launch;
  const originalPersistent=chromium.launchPersistentContext;
  const previousProfile=process.env.ROBOMEET_PROFILE_DIR;
  const previousHeadless=process.env.ROBOMEET_HEADLESS;
  const contexts=[];
  const workers=[];
  const installFixture=async context=>{
    contexts.push(context);
    await context.route('**/*',route=>{
      const url=new URL(route.request().url());
      if (url.hostname==='meet.google.com') return route.fulfill({contentType:'text/html',body:meetingHtml});
      if (url.hostname==='localhost') return route.fulfill({contentType:'text/html',body:appHtml});
      return route.abort();
    });
    return context;
  };
  chromium.launch=async options=>{
    const browser=await originalLaunch.call(chromium,options);
    const newContext=browser.newContext.bind(browser);
    browser.newContext=async options=>installFixture(await newContext(options));
    return browser;
  };
  chromium.launchPersistentContext=async (profile,options)=>installFixture(await originalPersistent.call(chromium,profile,options));
  process.env.ROBOMEET_HEADLESS='1';
  try {
    for (const [mode,expectedVisits] of [['anonymous',1],['persistent',1],['persistent',2]]) {
      if (mode==='persistent') process.env.ROBOMEET_PROFILE_DIR=temporary;
      else delete process.env.ROBOMEET_PROFILE_DIR;
      const events=[];
      const worker=createMeetingWorker({baseUrl:'http://localhost:4318',onEvent:event=>events.push(event)});
      workers.push(worker);
      await worker.join({url:'https://meet.google.com/abc-defg-hij',name:'RoboMeet AI'});
      await waitFor(()=>{
        const status=worker.status();
        assert.notEqual(status.status,'error',status.error);
        return status.admitted;
      });
      assert.equal(worker.status().status,'joined');
      const context=contexts.at(-1);
      const app=context.pages().find(page=>page.url().startsWith('http://localhost:4318'));
      assert.equal(await app.evaluate(()=>Number(localStorage.getItem('fixtureVisits'))),expectedVisits);
      await worker.setMode('listen');
      await worker.present({enabled:true});
      assert.equal(worker.status().sharing,true);
      await worker.present({enabled:false});
      assert.equal(worker.status().sharing,false);
      const diagnostics=await worker.diagnostics();
      assert.equal(diagnostics.media.input,'no-input');
      assert.equal(events.some(event=>event.type==='browser-profile'),mode==='persistent');
      await worker.leave();
      assert.equal(worker.status().status,'ended');
      assert.equal(context.pages().length,0);
    }
  } finally {
    for (const worker of workers) await worker.close();
    chromium.launch=originalLaunch;
    chromium.launchPersistentContext=originalPersistent;
    if (previousProfile===undefined) delete process.env.ROBOMEET_PROFILE_DIR; else process.env.ROBOMEET_PROFILE_DIR=previousProfile;
    if (previousHeadless===undefined) delete process.env.ROBOMEET_HEADLESS; else process.env.ROBOMEET_HEADLESS=previousHeadless;
    await rm(temporary,{recursive:true,force:true});
  }
});
