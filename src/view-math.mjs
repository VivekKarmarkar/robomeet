// The displayed formulas of one screen-sized part, written out cleanly. One job: transcribe, from the picture.
//
// A PDF's text layer does not carry mathematics. For the projectile notes it gives "v 0 2 sin 2 θ", "2g", "(8)" on
// three lines for H = v0² sin²θ / (2g): the square of sin is a flat "2", indistinguishable from the "2θ" of sin 2θ,
// and the 2026-09-22 honest-tester run heard the robot insist that equation (8) has sin 2θ. The picture of the part
// does carry it, so a vision model reads the formulas from the view's own render, once, when the deck is prepared.
// The result is reference text for the robot, stored beside the view's lines; it does not replace them.
const PROMPT = `This image is one screen-sized part of a document. Transcribe every displayed mathematical formula that is fully visible, top to bottom, as plain text a person could read aloud correctly:
- use Unicode: v₀ as v0, squares as ², θ, ½, ẏ, ẍ, ⟹, and write fractions as (numerator) / (denominator);
- start each with its equation number in parentheses when one is printed beside it, e.g. "(8) H = v0² sin²θ / (2g)";
- a line that is cut off by the top or bottom edge: add " [cut off]";
- only what is printed: no explanations, no formulas from prose sentences, nothing added.
Reply with a JSON array of strings and nothing else.`;

export async function transcribeViewMath({ png, apiKey = process.env.OPENAI_API_KEY, model = 'gpt-5.6-sol', fetchImpl = fetch }) {
  if (!apiKey) throw new Error('No API key for the vision transcription.');
  const res = await fetchImpl('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_output_tokens: 2000, input: [{ role: 'user', content: [{ type: 'input_text', text: PROMPT }, { type: 'input_image', image_url: `data:image/png;base64,${Buffer.from(png).toString('base64')}`, detail: 'high' }] }] }) });
  if (!res.ok) throw new Error(`Vision transcription failed (HTTP ${res.status}).`);
  const body = await res.json();
  const text = (body.output || []).flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('').trim();
  const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
  const list = JSON.parse(json);
  if (!Array.isArray(list)) throw new Error('The transcription is not a list.');
  return list.map(item => String(item).trim().slice(0, 200)).filter(Boolean).slice(0, 20);
}
