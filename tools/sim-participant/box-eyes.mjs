// A person's eyes on the amber box: a vision model is shown the REAL rendered stage (a crop around the box found in
// its pixels) and asked what a person in the meeting would see. One job: describe the box as seen, not as computed.
//
// Why a vision model and not the word geometry alone: the geometry says which PDF words overlap the box; a person
// judges something else, whether the box looks like it is around the thing, and whether its frame runs into a
// neighbouring symbol. The two are recorded side by side and a disagreement is itself a finding.
import { cropImage } from '../../src/stage-shot.mjs';

const KEY = process.env.OPENAI_API_KEY;

export async function lookAtBox({ png, found, target = '', apiKey = KEY, model = 'gpt-5.6-sol' }) {
  if (!found) return { seen: false, inside: '', clips: [], containsTarget: null, raw: 'no amber box in the frame' };
  const crop = await cropImage(png, found, { pad: 90, minWidth: 1100 });
  const ask = `This is a crop of a shared screen in a video meeting, showing notes on projectile motion. An amber (orange) rectangle has been drawn around something.
Answer as a careful person looking at it would, in exactly these lines:
INSIDE: the exact text or formula that sits inside the amber rectangle, written in plain text (write v0 for v with subscript 0, θ, ², ½ as they appear).
CLIPS: "none", or a list of every symbol or word OUTSIDE the target that the amber frame touches, crosses, cuts through or partly covers (for example a neighbouring comma or term).
${target ? `WHOLE: yes or no — is all of "${target}" inside the rectangle, with nothing of it cut off?` : ''}
LOOKS: one short phrase on how it looks to a viewer (for example "tight around the formula", "crowds the next term").`;
  const res = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_output_tokens: 700, input: [{ role: 'user', content: [
      { type: 'input_text', text: ask },
      { type: 'input_image', image_url: `data:image/png;base64,${crop.bytes.toString('base64')}`, detail: 'high' },
    ] }] }) });
  if (!res.ok) return { seen: true, inside: '', clips: [], containsTarget: null, raw: `vision HTTP ${res.status}` };
  const body = await res.json();
  const text = (body.output || []).flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('\n');
  const line = k => (text.match(new RegExp(`^\\s*${k}:\\s*(.*)$`, 'mi')) || [])[1]?.trim() || '';
  const clipsRaw = line('CLIPS');
  const clips = /^"?none"?\.?$/i.test(clipsRaw) || !clipsRaw ? [] : clipsRaw.split(/;|,(?![^()]*\))/).map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
  const whole = line('WHOLE').toLowerCase();
  return { seen: true, inside: line('INSIDE'), clips, containsTarget: whole ? whole.startsWith('yes') : null, looks: line('LOOKS'), raw: text.slice(0, 600), crop: crop.bytes };
}
