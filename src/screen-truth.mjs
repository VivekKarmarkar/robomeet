// Tell the robot what is really on its shared screen, on the channel that cannot paraphrase it away.
//
// Two facts from OpenAI's own docs decide the shape of this (live-delegation, "Send the right kind of update"):
//   session.thinking.append    - "Information for internal reasoning, not spoken on append but usable for relevant
//                                 user questions"        <- the verdict: a fact, held until someone asks
//   session.commentary.append  - "Information the model should speak aloud, paraphrasing the appended text"
//   session.instructions.append- "System-level instructions for the live model"  <- the binding constraint
// The verdict must NOT go down the commentary channel: it is trained to paraphrase, and a paraphrase of an exact
// word list is exactly how "I boxed only the vertical velocity" gets regenerated. So the facts go to thinking, and
// when the box is not what was asked for, the prohibition goes to instructions, where it binds.
//
// Watches the store the way src/screen-context.mjs watches it. Adds nothing to the pointer's own path, so a failure
// here can never stop a highlight being drawn. One job.
import { wordsForDeck, wordsInView } from './word-boxes.mjs';
import { findPhrase } from './fine-pointer.mjs';
import { auditHighlight } from './highlight-oracle.mjs';

// The one rule behind every false claim in test 7 and in the adversarial suite: the robot narrated screen facts it
// was never given. It said what the box held, then how the pointer "snaps", then that the box had not moved after a
// scroll, then a formula from memory that was not on the page. Each is the same error, so this is one rule, not four
// patches. It rides with the prohibition because that is the channel that cannot be paraphrased away.
export const ONLY_WHAT_YOU_ARE_TOLD = 'Everything you know about your shared screen is what RoboMeet has told you. State that and nothing else about it. You cannot see the screen, so do not describe how the pointer chooses what to box, do not say whether the box has moved or is unchanged since the screen last moved, and do not supply text or a formula that RoboMeet has not shown you, even one you are sure of.';

const deckCache = new Map(); // slug -> words.json (per process; a deck's words never change)

async function wordsFor(publicDir, slug) {
  if (!slug) return null;
  if (deckCache.has(slug)) return deckCache.get(slug);
  const built = await wordsForDeck(publicDir, slug).catch(() => null);
  deckCache.set(slug, built);
  return built;
}

// The view the pointer is on, its words, and the pixel size of its exact render.
function viewOf(state, pointer) {
  const slide = state.slides?.[pointer.slide];
  const view = slide?.views?.[pointer.view];
  if (!slide || !view) return null;
  return { slide, view, page: Number(slide.page) || pointer.slide + 1 };
}

// The verdict for whatever is boxed right now. `phrase` is what was asked for, when the caller knows it.
export async function truthOfHighlight({ state, publicDir, phrase = '' }) {
  const pointer = state?.pointer;
  if (!pointer) return { verified: false, say: 'Nothing is boxed on the shared screen right now.' };
  const found = viewOf(state, pointer);
  if (!found) return { verified: false, say: 'RoboMeet cannot place the box on a view, so what it contains cannot be checked. Do not claim what is inside it.' };
  const { slide, view, page } = found;
  const box = view.highlight;
  const words = await wordsFor(publicDir, state.deckSlug);
  const pageWords = words?.pages?.[page - 1]?.words || [];
  const inView = wordsInView(pageWords, view);
  const asked = phrase ? findPhrase(inView, phrase)?.words || null : null;
  const audit = auditHighlight({ words: inView, box, rect: view, asset: view.asset ? { width: 1920, height: 1080 } : null, asked, phrase });
  return { ...audit, page, slide: pointer.slide, view: pointer.view };
}

// Sends the verdict as a fact, and a prohibition as an instruction when the box is not what was asked for.
export async function tellTruth({ state, publicDir, live, phrase = '' }) {
  const verdict = await truthOfHighlight({ state, publicDir, phrase });
  if (!verdict.say) return verdict;
  live.context?.(`About the box on your shared screen: ${verdict.say}`, false, { replay: false }); // thinking
  if (verdict.verified === false || verdict.exact === false) {
    await live.instruct?.(`You have just drawn a box on your shared screen. ${verdict.say} ${ONLY_WHAT_YOU_ARE_TOLD}`).catch(() => {});
  }
  return verdict;
}

// Watches for a new pointer and tells the robot the truth about it. Returns an unwatch function, like watchScreen.
// `phraseOf` lets the caller supply what was asked for; without it the verdict states what is in the box only.
export function watchPointerTruth({ store, live, publicDir, phraseOf = () => '', debounceMs = 120 }) {
  let last = null, timer = null, running = false;
  const send = async () => {
    timer = null;
    if (running) return;
    const state = store.state, pointer = state.pointer;
    if (!pointer) { last = null; return; }
    const key = `${state.deckSlug}|${pointer.slide}|${pointer.view}|${JSON.stringify(state.slides?.[pointer.slide]?.views?.[pointer.view]?.highlight || null)}`;
    if (key === last || !live.activeSession?.()) return;
    last = key;
    running = true;
    try { await tellTruth({ state, publicDir, live, phrase: phraseOf(state) }); }
    catch { last = null; } // a failure here must never wedge the watcher
    finally { running = false; }
  };
  const onChange = () => { if (!timer) timer = setTimeout(send, debounceMs); };
  store.on('change', onChange);
  return () => { clearTimeout(timer); store.off('change', onChange); };
}
