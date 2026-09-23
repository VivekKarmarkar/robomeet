// When the robot may greet the people it has just joined. One job: never talk over someone to say hello.
//
// bin/attend.mjs fires its greeting cue the moment a human is present. In the 2026-09-22 honest-tester runs the
// person was mid-sentence, reading the notes aloud, and the robot greeted over them. A greeting waits for a pause:
// nobody speaking now, and nobody heard in the last PAUSE_MS. `media` is the meeting's media state as attend sees it
// ({ input: 'active' | ..., lastAudibleAt: ms }).
export const PAUSE_MS = 1500;
// After a voice restart the people are the same and the robot remembers nothing; after a rejoin it has only the recap.
// Saying "someone just joined" in either case made it welcome people who had been there all along (2026-09-22).
export const RESTART_CUE = 'Your voice session just restarted in the middle of this meeting. Nobody new has joined, and you do not remember what was said before the restart. If someone asks, say so plainly and ask them to fill you in.';
export const REJOIN_CUE = 'You have just rejoined this meeting after dropping out. Nobody new has joined. What you know of the earlier conversation is only the recap in your instructions; do not claim more than it says.';
// Which cue attend sends when voice starts with people present.
export function cueFor({ greetedBefore = false, leftAlone = false, rejoined = false, greeting }) {
  if (greetedBefore && !leftAlone) return RESTART_CUE;
  if (!greetedBefore && rejoined) return REJOIN_CUE;
  return greeting;
}

export function readyToGreet({ media = {}, now = Date.now(), pauseMs = PAUSE_MS } = {}) {
  if (media.input === 'active') return false;
  const last = Number(media.lastAudibleAt) || 0;
  return !(last > 0 && now - last < pauseMs);
}
