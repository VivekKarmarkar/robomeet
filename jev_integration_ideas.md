# Jev integration ideas for RoboMeet

## What Jev is

[TypeSafe AI](https://typesafe.ai/blog/introducing-system-one-models-and-jev) launched Jev on September 15, 2026
($40M seed, founded by OpenAI alum Diogo Almeida). It is a **decision model, not a generation model**: you give it
a state and typed questions, it returns one answer per question in a single parallel pass.

Three question types:
- **Choice**: pick one from a list of options you supply
- **Score**: rate something on a scale you define
- **Null (boolean)**: probability that a yes/no statement is true

Key numbers:
- **Latency**: 70–500 ms end-to-end
- **Cost**: $0.042 per million input tokens, output is free
- **Speed**: 40–200x faster than frontier LLMs on comparable tasks
- **Constraint**: max 255 options per choice; no image input (yet); no text generation

It cannot hallucinate or produce type errors because it only selects from options you supply.

Sources:
- [TypeSafe blog: Introducing System One Models & Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- [DataCamp: Jev System One Model](https://www.datacamp.com/blog/system-one-models-jev)
- [MindStudio: Jev Explained](https://www.mindstudio.ai/blog/jev-system-one-model-launch)
- [jev-browser on GitHub](https://github.com/jkudish/jev-browser) — browser automation with Jev picking actions

## The problem in RoboMeet today

When someone says "scroll down" or "point at equation 3" in a meeting, the chain is:

1. **GPT Live** (voice model) hears it, decides to delegate
2. **gpt-5.6-sol** (backend reasoning model, via Responses delegation) picks a tool
3. **The coding agent** (Claude) receives `ask_coding_agent`, calls an MCP tool, replies
4. **The RoboMeet server** executes the command (stage move, highlight, etc.)

Step 4 takes milliseconds. Steps 1–3 take **seconds**. The robot freezes while the coding agent works.
For mechanical actions (scroll, highlight, next slide, share on/off), the coding agent adds nothing — it just
calls the MCP tool and replies. The backend model already knows which tool to call.

## How GPT Live delegation works

[OpenAI docs: Delegation and tools in GPT-Live](https://developers.openai.com/api/docs/guides/live-delegation)

Two modes (chosen at session creation, cannot mix in one session):

### Responses delegation (what we use now)
GPT Live → OpenAI-hosted backend model (gpt-5.6-sol) → tools → results back to voice.
The backend model picks the tool. We define the tools. OpenAI runs the chain.
**Limitation**: the backend model must be an OpenAI model. No Jev here.

### Client delegation
GPT Live fires tool calls to **our application**. We intercept them, route them to whatever we
want (Jev, Claude, a database, a direct function call), and send results back via
`session.commentary.append` or `session.thinking.append`.

Key facts:
- The voice model **stays conversational** while our code works — it does not block
- We maintain conversation context ourselves (collect transcripts, build requests)
- We can route to **any model or service**, not just OpenAI
- Cannot switch from Responses to client delegation mid-session (or vice versa)
- Can update tools, instructions, etc. mid-session with `session.update`

## The idea: client delegation with Jev for fast actions

Split the tools into two tiers:

### Tier 1 — Fast actions (Jev or direct execution, < 1 second)
- `stage` (move the shared screen to a slide/view)
- `highlight` / `point_at` (draw a box on the screen)
- `presenter` control (pause, resume, next, previous, stop, goto)
- `share` on/off
- `slide` (select a slide)

These are structured decisions from a known set. Jev picks the action in 70–500 ms, or our
server executes them directly (they are already just function calls in `src/server.mjs`).

### Tier 2 — Real work (coding agent, seconds to minutes)
- `ask_coding_agent` (build a deck, write narration, research, answer questions)
- `present_pdf` / `present_file` (build a deck from a document)
- `take_note` (save a meeting note)
- `present_slides` (display text/picture slides)

These need generation, file access, or code execution.

### Architecture

```
GPT Live (voice)
    │
    ▼ tool call
Our Node server (src/live.mjs, client delegation)
    │
    ├─ Tier 1? ──→ Execute directly in src/server.mjs (< 50 ms)
    │               or ask Jev to pick the action (70–500 ms)
    │
    └─ Tier 2? ──→ Route to coding agent (Claude) as before
                    Result delivered later via session.commentary.append
```

### What changes
- `src/live.mjs`: switch from `delegation: { type: 'responses', ... }` to client delegation
- Add a triage function: given the tool name, route to tier 1 or tier 2
- Tier 1 tools call `src/server.mjs` commands directly and return the result
- Tier 2 tools queue a job for the coding agent (same as `ask_coding_agent` today)
- Maintain conversation context ourselves (we already collect transcripts)

### What Jev adds beyond direct execution
For tier 1, most actions can be executed directly by tool name (the voice model already says
which tool). Jev's value would be:
- **Classifying ambiguous requests**: "show me that equation" → is this a `stage` move, a
  `highlight`, or an `ask_coding_agent`? Jev picks from the options in 70–500 ms.
- **Picking the right target**: "point at the third result" → which of the 30 line boxes on
  screen is the third result? Jev scores them.
- **Browser navigation** (future): if RoboMeet ever needs to navigate web pages live (not
  just capture them), [jev-browser](https://github.com/jkudish/jev-browser) shows this works
  fast and cheap.

### Tradeoff
We lose gpt-5.6-sol's judgment on tool selection. With Responses delegation, the backend model
reads the full conversation and picks the right tool with context. With client delegation, our
code triages. For clear tool calls ("next slide") this is trivial. For ambiguous requests
("show me that thing we talked about") it is harder — we would need Jev or a small LLM to
classify.

## Expected impact

| Action | Today | With client delegation |
|---|---|---|
| Stage move ("next part") | 3–8 s (voice → backend → coding agent → MCP → server) | < 1 s (voice → server → direct) |
| Highlight ("point at eq 3") | 3–6 s | < 1 s |
| Presenter control | 3–6 s | < 1 s |
| Build a deck from a PDF | 20–120 s (coding agent does real work) | Same (still needs the coding agent) |
| Answer a research question | 20–60 s | Same |
| The freeze during delegated work | Robot freezes for seconds | Robot keeps talking (client delegation is non-blocking) |

The 3-second gap between narrated parts is still GPT Live's own speech generation latency and
would not change.

## Practical next step

Build a client-delegation session alongside the current Responses one, behind `ROBO_DELEGATION=client`
(default stays `responses`). Wire tier-1 tools to execute directly in the server. Keep tier-2
tools routed to the coding agent. Measure the difference in a live test.

## Open questions
- Does client delegation change how the voice model decides to delegate? (Does it delegate
  more or less readily without a backend model's judgment?)
- How much conversation context do we need to maintain ourselves, and does the voice model's
  quality degrade without the backend model's reasoning?
- Is Jev's 255-option limit enough for line-box scoring on a dense page?
- Can we update tools mid-session to add/remove tier-1 options as the deck changes?
