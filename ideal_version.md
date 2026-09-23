# The ideal version: a robot scientist in the meeting

Written 2026-09-22 from Vivek's description of where RoboMeet should end up, and the picture of it done well that
he confirmed before asking for this file.

## What it is

Not quite a product: a way of extending the scaffolding of our system so that Vivek can do a lot of things in one
place. A Claude Code or Codex session joins a Google Meet or Zoom call as a fully interactive participant: a robot
scientist. Its range of participation runs from silently listening, through capturing notes and its own ideas, to
navigating and presenting a deck, pointing at exactly the right thing, and working at a live blackboard.

**Status rule for this whole file: every feature below still needs rigorous testing.** That includes the ones that
partly exist today. A feature counts as done only when it has been tested rigorously, with a real human in a real
call where that matters, and not before. "Exists today" notes below describe code, never proof.

## What it looks like done well, for the human in the call

You open a Meet and the robot is already there. It knows its name, which coding session it is attached to, and what
it can and cannot do. You set how involved it should be, the way you would brief a colleague before a meeting. The
same participant then covers the whole range below. The human never has to think about five things:

1. **It knows when to talk.** It does not interrupt, does not go silent when asked something, and does not narrate
   what nobody asked for.
2. **It never claims what it cannot check.** If it cannot tell, it says so.
3. **Moves feel instant.** A scroll or a highlight that takes three seconds breaks the illusion of a colleague. It
   has to land in well under a second.
4. **Slow work never freezes it.** While it builds a deck or runs code, it keeps talking and reports back later.
5. **You give it a dial, not a script.** "Just listen today" or "run the slides for me" is the whole instruction.

## The dial: the range of participation

Each level includes everything below it.

### 1. Silent listener
Hears everything, says nothing. Afterwards you get accurate notes, not a transcript dump. The coding agent is
already listening to the transcript, so it can be the one that takes the notes.
- Exists today: the coding session can read the live transcript; `take_note` saves a note.
- Rigorous testing must show: notes are accurate against the recording, nothing important is missed, nothing is
  invented, and the robot stays genuinely silent for a whole meeting.

### 2. Idea capturer
Still silent, but it writes down its own thoughts as they occur, for example "the bound in equation 4 assumes no
drag; check it against Tuesday's data". GPT Live itself may be smart enough to note its own new ideas. This is what
makes it a scientist rather than a stenographer.
- Exists today: nothing specific. `take_note` could carry it; no prompting or testing for original ideas.
- Rigorous testing must show: the ideas are genuinely its own and genuinely useful, are kept apart from the
  meeting's notes, and never leak into speech when it is told to stay silent.

### 3. Navigator
You present and just talk. "Go back to the parabola", and it is there almost instantly. You never touch the deck.
- Exists today: the `scroll` tool (next, back, the top, the end, a part, a page), wired into the voice model's
  delegation policy.
- Rigorous testing must show: it scrolls on every request and only then, lands where the human meant, never claims
  a move it did not make, and does it fast enough to feel instant.

### 4. Pointer
"Which term is the vertical velocity?" It boxes exactly that term, not the whole line it sits on. If you insist it
boxed the wrong thing, it tells you what the box really holds. This is the small-things discipline from live test 7,
the equation that went wrong.
- Exists today: word-level pointing, and a check of what the painted box actually holds.
- Rigorous testing must show: it boxes exactly what was asked across many documents and phrasings, and holds its
  ground under spoken pressure with a real human voice.

### 5. Presenter
Walks through a document itself, pauses when someone speaks, and picks up when told to continue.
- Exists today: the narrated walk.
- Rigorous testing must show: no cut-offs, no talking over people, no pausing forever, and a clean resume every time.

### 6. Blackboard
Someone says "so the range is v squared sine two theta over g" and the equation appears on a board, typeset, as they
say it, with live LaTeX rendering through KaTeX. It sketches the trajectory, labels the angle, and redraws when the
argument changes.
- Exists today: nothing.
- Rigorous testing must show: the equation rendered is the one that was said, it appears fast enough to keep up with
  speech, drawings are correct rather than decorative, and it corrects itself when the argument changes.

## Qualities that run across every level

### Knowing who it is and what it can do
It states its own name, the session it is attached to, its models, and its real tools, correctly, and never offers
a capability it lacks.
- Rigorous testing must show: correct self-description every time, including after the tool list changes.

### Knowing when to talk and when to stay quiet
The hardest item on the list, because GPT Live decides its own turns and has no settings for it. It can only be
shaped through instructions and what we feed it.
- Rigorous testing must show: correct behaviour with real human turn-taking. The automated voice harness cannot
  measure this yet: synthetic speech followed by digital silence does not reliably mark the end of an utterance.

## The fast path: quick decisions without the slow reasoning path

Scrolling, highlighting and changing slides are small picks from a known menu. They should never go through the slow
reasoning path. The idea is to use client delegation instead of Responses delegation for these, with Jev
(TypeSafe AI's decision model) making the quick picks, and the reasoning model kept for real work. That means
talking to the session that started the Jev work about using its API key. A fast menu of known actions is also a
checkable one, so speed and truthfulness come from the same design choice. Background research:
`jev_integration_ideas.md`.
- Exists today: nothing on this path. Scroll and highlight still go through Responses delegation.
- Rigorous testing must show: the fast path is measurably faster end to end, picks the right action, never acts when
  it should not, and hands anything that is not a quick pick back to the reasoning model.

## Test ledger

| Feature | Exists today | Rigorously tested |
| --- | --- | --- |
| Silent listener, notes | partly | no |
| Idea capturer | no | no |
| Navigator (scroll) | yes | no |
| Pointer (exact box, holds under pressure) | yes | no |
| Presenter | yes | no |
| Blackboard, live KaTeX, drawing | no | no |
| Knowing who it is and what it can do | partly | no |
| Knowing when to talk | shaped only by instructions | no |
| Fast path (Jev, client delegation) | no | no |
