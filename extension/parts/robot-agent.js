// Robot control surface for the RoboMeet worker. Requires window.RoboMeetMedia (src/meet-media.js) in the same page.
window.__robomeetAgent = (() => {
  const ui = robomeetUi;
  const media = () => { if (!window.RoboMeetMedia) throw new Error('RoboMeet media adapter is not loaded.'); return window.RoboMeetMedia; };
  const presentingText = () => [...document.querySelectorAll('div, span')].find(element => ui.visible(element) && /^(You.re presenting|You are presenting)/i.test((element.innerText || '').trim()));
  async function present(enabled) {
    if (enabled) {
      const button = ui.findButton(/^(Present now|Share screen|Present screen)/i);
      if (!button) throw new Error('Google Meet shows no presentation button.');
      button.click();
      const option = await ui.waitFor(() => [...document.querySelectorAll('[role="menuitem"], [role="option"], li, span')]
        .find(element => ui.visible(element) && /^(Your entire screen|Entire screen|A tab|A window)$/i.test((element.innerText || '').trim())), 1500);
      if (option) option.click();
      const confirmed = await ui.waitFor(() => ui.findButton(/^(Stop presenting|Stop sharing)/i) || presentingText(), 10_000);
      if (!confirmed) throw new Error('Google Meet did not confirm the presentation.');
      return true;
    }
    const stop = await ui.waitFor(() => ui.findButton(/^(Stop presenting|Stop sharing)/i), 3000);
    if (!stop) throw new Error('Google Meet shows no stop-presenting control.');
    stop.click();
    await ui.waitFor(() => !ui.findButton(/^(Stop presenting|Stop sharing)/i), 5000);
    return false;
  }
  return {
    ready: () => Boolean(window.RoboMeetMedia),
    drain: () => ({ candidates: robomeetQueue.candidates.splice(0), events: robomeetQueue.events.splice(0) }),
    answer: offer => media().answer(offer),
    addCandidate: item => media().addCandidate(item),
    health: () => media().health(),
    publicationStats: () => media().publicationStats(),
    close: () => media().close(),
    join: name => ui.join(name),
    joinTarget: name => ui.joinTarget(name),
    inertPoint: ui.inertPoint,
    activation: ui.activation,
    admitted: ui.admitted,
    text: ui.text,
    buttons: ui.buttonLabels,
    enableInputs: ui.enableInputs,
    leave: ui.leave,
    present,
  };
})();
