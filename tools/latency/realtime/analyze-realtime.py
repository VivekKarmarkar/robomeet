import os, sys, json, glob
os.chdir(os.path.dirname(os.path.abspath(__file__)))
f = sys.argv[1] if len(sys.argv) > 1 else max(glob.glob('run-realtime-*.json'), key=os.path.getmtime)
run = json.load(open(f)); log = run['page']['log']
gum = next(e['t'] for e in log if e['type'] == 'gum.resolved'); T = lambda e: (e['t'] - gum) / 1000
print(f"== {f}\n   model {run['model']}  turn_detection {json.dumps(run['turnDetection'])}")
if run.get('callError'): print('   CALL ERROR:', run['callError'])
print('-- startup')
for key in ['pc.created', 'dc.open']:
    for e in log:
        if e['type'] == key: print(f'  {T(e):7.2f}  {key}'); break
for e in log:
    if e['type'] == 'pc.state': print(f"  {T(e):7.2f}  pc.state {e['state']}")
    if e['type'] == 'dc' and e['ev'] in ('session.created', 'session.updated', 'error'): print(f"  {T(e):7.2f}  dc {e['ev']} {e.get('error', '')}")
print('-- timeline')
IN = ('conversation.item.input_audio_transcription.delta', 'conversation.item.input_audio_transcription.completed')
OUT = ('response.output_audio_transcript.delta', 'response.audio_transcript.delta')
rows = []
for e in log:
    if e['type'] in ('mic.onset', 'mic.offset', 'robot.onset', 'robot.offset'): rows.append((T(e) if 'end' not in e else (e['end'] - gum) / 1000, e['type'], ''))
    if e['type'] == 'dc':
        if e['ev'] in ('input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped', 'response.created', 'response.done'): rows.append((T(e), 'dc ' + e['ev'], ''))
        if e['ev'] in IN: rows.append((T(e), 'in-text', repr(e.get('delta', e.get('transcript', '')))[:40]))
        if e['ev'] in OUT: rows.append((T(e), 'out-text', repr(e.get('delta', ''))[:40]))
rows.sort(key=lambda r: r[0])
for t, k, v in rows: print(f'  {t:7.2f}  {k:48s} {v}')
print('-- per utterance: mic end -> VAD speech_stopped, first output text, first robot audio')
mics = [(e['end'] - gum) / 1000 for e in log if e['type'] == 'mic.offset']
onsets = [T(e) for e in log if e['type'] == 'mic.onset']
stopped = [T(e) for e in log if e['type'] == 'dc' and e['ev'] == 'input_audio_buffer.speech_stopped']
out_text = [T(e) for e in log if e['type'] == 'dc' and e['ev'] in OUT]
robot = [T(e) for e in log if e['type'] == 'robot.onset']
sched = run['track']['utterances']
fmt = lambda v: f'{v:8.2f}' if v is not None else '       -'
print(f"  {'utterance':10s} {'onset':>6s} {'end':>6s} {'->vad':>8s} {'->text':>8s} {'->audio':>8s}")
for u in sched:
    k = next((i for i, on in enumerate(onsets) if abs(on - u['onset']) < 0.6), None)
    if k is None or k >= len(mics): print(f"  {u['name']:10s} {u['onset']:6.2f}   (not detected on the microphone)"); continue
    on, end = onsets[k], mics[k]
    nxt = lambda xs: next((x - end for x in xs if x > end - 0.3), None)
    print(f"  {u['name']:10s} {on:6.2f} {end:6.2f} {fmt(nxt(stopped))} {fmt(nxt(out_text))} {fmt(nxt(robot))}")
said = ''.join(e.get('delta', '') for e in log if e['type'] == 'dc' and e['ev'] in OUT)
print('ROBOT SAID:', said[:400])
