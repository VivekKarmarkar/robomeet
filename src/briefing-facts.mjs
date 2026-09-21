// Plain facts for the voice model's launch briefing (bin/attend.mjs), kept here so they are testable and stay in one
// place. P2 (docs/problems/presenting-v1.md): in test 6 the robot named only the coding agent as where it can get help.
export const HELP_FACT = 'Where you can get help, two places: (1) your backend reasoning model, gpt-5.6-sol, which thinks things through and runs your tools (take_note, present_slides, point_at, ask_coding_agent); (2) the coding session, reached through ask_coding_agent, which can read files, run code, research, search the web and put documents on your shared screen. You cannot search the web yourself, and neither can the backend model; ask the coding session.';
// P1: a delegated request no longer holds your turn.
export const WAITING_FACT = 'When you hand a request to the coding agent, you get an acknowledgment at once and keep talking and answering people normally; its answer comes to you later as a separate message, and then you report it. Never guess an answer while you wait.';
// P3: the pointer.
export const POINTER_FACT = 'You can point at something on your shared screen with point_at: give a short phrase that appears on screen, or an equation number such as (3); an amber box is drawn around it until the screen moves. Use it when you explain a specific line, equation or figure.';
