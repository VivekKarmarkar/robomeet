// Shared Meet page helpers (runs in the page's MAIN world, inside the generated wrapper's scope).
const robomeetUi = (() => {
  const visible = element => Boolean(element) && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const labelOf = element => (element.getAttribute('aria-label') || element.innerText || '').replace(/\s+/g, ' ').trim();
  const enabled = element => !element.disabled && element.getAttribute('aria-disabled') !== 'true';
  const buttons = () => [...document.querySelectorAll('button, [role="button"]')].filter(visible);
  const findButton = pattern => buttons().find(button => pattern.test(labelOf(button)));
  const text = () => (document.body?.innerText || '').slice(0, 6000);
  const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  async function waitFor(check, milliseconds) {
    const end = Date.now() + milliseconds;
    while (Date.now() < end) { const value = check(); if (value) return value; await pause(150); }
    return null;
  }
  // "Switch here" would move another session of this account out of the call, so it is never chosen.
  const JOIN = /^(Ask to join(?: anyway)?|Join now|Join the call now|Join anyway|Join here too)$/i;
  const LEAVE = /^(Leave call|Leave meeting|Exit call)/i;
  function nameInput() {
    return [...document.querySelectorAll('input[placeholder="Your name"], input[aria-label="Your name"], input[name="name"]')].find(visible);
  }
  function setValue(input, value) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function join(name) {
    const input = nameInput();
    if (input && !input.value && name) setValue(input, name);
    const button = buttons().find(item => JOIN.test(labelOf(item)) && enabled(item));
    if (button) { button.click(); return { clicked: labelOf(button), text: text().slice(0, 800) }; }
    return { clicked: null, text: text().slice(0, 800) };
  }
  const center = element => { const box = element.getBoundingClientRect(); return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }; };
  // Reports where to act next, without acting: the empty guest-name field if Meet asks for a name,
  // otherwise the enabled Join button.
  function joinTarget(name) {
    const input = nameInput();
    if (input && !input.value && name) return { label: null, nameInput: center(input), text: '' };
    const button = buttons().find(item => JOIN.test(labelOf(item)) && enabled(item));
    return button ? { label: labelOf(button), ...center(button), text: '' } : { label: null, text: text().slice(0, 800) };
  }
  const activation = () => ({ hasBeenActive: navigator.userActivation?.hasBeenActive ?? null });
  // A viewport point whose element (and ancestors) has no click behaviour, for a harmless activating click.
  const interactive = 'a, button, input, textarea, select, video, label, [role="button"], [role="link"], [role="menuitem"], [role="checkbox"], [role="dialog"], [tabindex], [jsaction*="click"], [onclick]';
  function inertPoint() {
    const w = innerWidth, h = innerHeight;
    const candidates = [[w / 2, h - 3], [3, h / 2], [w - 3, h / 2], [w / 2, 3], [3, h - 3], [w - 3, h - 3], [w * 0.25, h * 0.75], [w * 0.75, h * 0.25]];
    for (const [x, y] of candidates.map(([x, y]) => [Math.round(x), Math.round(y)])) {
      const element = document.elementFromPoint(x, y);
      if (element && !element.closest(interactive)) return { x, y };
    }
    return null;
  }
  const admitted = () => Boolean(findButton(LEAVE));
  function leave() { const button = findButton(LEAVE); if (button) button.click(); return Boolean(button); }
  function enableInputs() {
    const clicked = [];
    for (const pattern of [/^Turn on microphone/i, /^Turn on camera/i]) {
      const button = findButton(pattern);
      if (button && enabled(button)) { button.click(); clicked.push(labelOf(button)); }
    }
    return clicked;
  }
  const buttonLabels = () => buttons().map(labelOf).filter(Boolean).slice(0, 60);
  return { visible, labelOf, buttons, findButton, text, pause, waitFor, join, joinTarget, inertPoint, activation, admitted, leave, enableInputs, buttonLabels };
})();
