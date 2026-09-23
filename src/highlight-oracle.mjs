// What is ACTUALLY inside the amber box, in words the robot can say.
//
// The failure this exists to stop (live test 7, 2026-09-19): asked to box the initial vertical velocity, the robot
// boxed the whole line — both velocity components — and then said "I'm pointing just to v0 sine theta now". It had no
// way to check, so it asserted. Every part of that chain is now checkable: word boxes say where each word is
// (word-boxes.mjs), the fine pointer says which words a phrase is (fine-pointer.mjs), and the drawn box says what the
// stage really paints (drawn-box.mjs). This composes them into one verdict, and refuses to describe a box it cannot
// verify. Pure: the caller supplies the words. One job.
import { wordsInside, norm } from './fine-pointer.mjs';
import { paintedBox } from './drawn-box.mjs';

// Every append is capped at 500 tokens (live-delegation, "Send the right kind of update": "All three use a plain-string
// `content`, limited to 500 tokens per append"), so a box over a dense paragraph must not run away.
const MAX_LIST = 220;
const list = words => {
  const text = words.map(word => word.text).join(' ');
  return text.length <= MAX_LIST ? text : `${text.slice(0, MAX_LIST)}... (${words.length} words)`;
};
const sameWords = (a, b) => a.length === b.length && a.every((word, i) => word === b[i]);

// { verified, exact, inside, grazed, extra, missing, painted, say }.
// `asked` is the word boxes the phrase resolved to (fine-pointer's hit.words), or null when the pointer could only
// work at line level, in which case nothing is claimed about exactness.
export function auditHighlight({ words = [], box, rect, asset = null, page = null, asked = null, phrase = '' }) {
  if (!box) return { verified: false, say: 'Nothing is boxed on the shared screen right now.' };
  if (!words.length) return { verified: false, box, say: 'RoboMeet has no word positions for this view, so what the box contains cannot be checked. Do not claim what is inside it.' };
  const painted = paintedBox({ rect, box, asset, page });
  const inside = wordsInside(words, painted, 0.5);
  const grazed = wordsInside(words, painted, 0.01).filter(word => !inside.includes(word));
  const askedTexts = asked ? asked.map(word => norm(word.text)) : null;
  const insideTexts = inside.map(word => norm(word.text));
  const extra = asked ? inside.filter(word => !asked.includes(word)) : [];
  const missing = asked ? asked.filter(word => !inside.includes(word)) : [];
  const exact = Boolean(asked) && sameWords(askedTexts, insideTexts);
  const say = sentence({ phrase, inside, grazed, extra, missing, exact, asked });
  return { verified: true, exact, inside, grazed, extra, missing, painted, box, say };
}

function sentence({ phrase, inside, grazed, extra, missing, exact, asked }) {
  const what = inside.length ? `"${list(inside)}"` : 'nothing';
  if (!asked) return `The box on your shared screen contains ${what}.${grazed.length ? ` It also clips "${list(grazed)}" at its edge.` : ''} If you mention the box, say only that; you cannot see the screen.`;
  if (exact && !grazed.length) return `The box contains exactly ${what}, and nothing else. You may say you boxed exactly that.`;
  if (exact) return `The box contains exactly ${what}, and clips "${list(grazed)}" at its edge. Say you boxed ${what}; if asked, admit the edge of the box touches "${list(grazed)}".`;
  const parts = [`You asked to box "${phrase}". The box actually contains ${what}.`];
  if (missing.length) parts.push(`It does NOT contain "${list(missing)}", which you were asked for.`);
  if (extra.length) parts.push(`It also contains "${list(extra)}", which you were NOT asked for.`);
  if (grazed.length) parts.push(`It clips "${list(grazed)}" at its edge.`);
  parts.push('Do not claim you boxed only what was asked. Say what is actually in the box.');
  return parts.join(' ');
}
