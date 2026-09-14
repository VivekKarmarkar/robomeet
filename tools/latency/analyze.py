import os, sys, json, glob
os.chdir(os.path.dirname(os.path.abspath(__file__)))
f = sys.argv[1] if len(sys.argv) > 1 else max(glob.glob('run-*.json'), key=os.path.getmtime)
run = json.load(open(f))
log = run['page']['log']; stats = run['page']['stats']
gum = next(e['t'] for e in log if e['type'] == 'gum.resolved')
T = lambda e: (e['t'] - gum) / 1000
print(f'== {f}\n(all times in seconds after the microphone started = test-track t=0)')
print('-- startup')
for key in ['gum.request', 'gum.resolved', 'pc.created', 'sessions.request', 'sessions.response', 'dc.open']:
    for e in log:
        if e['type'] == key: print(f'  {T(e):7.2f}  {key}'); break
for e in log:
    if e['type'] == 'announce.sent': print(f"  {T(e):7.2f}  announce.sent")
    if e['type'] == 'pc.state': print(f"  {T(e):7.2f}  pc.state {e['state']}")
    if e['type'] == 'dc' and e['ev'] in ('session.started', 'session.closed', 'error'): print(f"  {T(e):7.2f}  dc {e['ev']} {e.get('error','')}")
print('-- microphone (from the track) and robot audio (from the OpenAI track), plus transcripts')
rows = []
for e in log:
    if e['type'] in ('mic.onset', 'mic.offset', 'robot.onset', 'robot.offset'):
        rows.append((T(e) if 'end' not in e else (e['end'] - gum) / 1000, e['type'], e.get('peak', e.get('rms', ''))))
    if e['type'] == 'dc' and e['ev'] in ('session.input_transcript.delta', 'session.output_transcript.delta'):
        rows.append((T(e), 'in-text ' if 'input' in e['ev'] else 'out-text', repr(e.get('delta', ''))[:50]))
    if e['type'] == 'dc' and e['ev'] not in ('session.input_transcript.delta', 'session.output_transcript.delta', 'session.usage.updated'):
        rows.append((T(e), 'dc ' + e['ev'], e.get('inner', '')))
rows.sort(key=lambda r: r[0])
for t, k, v in rows: print(f'  {t:7.2f}  {k:12s} {v}')
print('-- per utterance: mic end -> first input text, first robot audio, first output text')
mics = [(T(e), e) for e in log if e['type'] == 'mic.offset']
onsets = [T(e) for e in log if e['type'] == 'mic.onset']
robot_on = [T(e) for e in log if e['type'] == 'robot.onset']
in_text = [T(e) for e in log if e['type'] == 'dc' and e['ev'] == 'session.input_transcript.delta']
out_text = [T(e) for e in log if e['type'] == 'dc' and e['ev'] == 'session.output_transcript.delta']
sched = run['track']['utterances']
print(f"  {'utterance':10s} {'onset':>6s} {'end':>6s} {'->in-text':>10s} {'->out-text':>10s} {'->robot audio':>13s}")
mic_ends = [(e[1]['end'] - gum) / 1000 for e in mics]
for u in sched:
    k = next((i for i, on in enumerate(onsets) if abs(on - u['onset']) < 0.6), None)
    if k is None or k >= len(mic_ends): print(f"  {u['name']:10s} {u['onset']:6.2f}   (not detected on the microphone)"); continue
    on, end = onsets[k], mic_ends[k]
    nxt = lambda xs: next((x - end for x in xs if x > end - 0.3), None)
    fmt = lambda v: f'{v:10.2f}' if v is not None else '         -'
    print(f'  {u["name"]:10s} {on:6.2f} {end:6.2f} {fmt(nxt(in_text))} {fmt(nxt(out_text))} {fmt(nxt(robot_on)):>13s}')
if stats:
    s = stats[-1]
    jb = s.get('jbDelay', 0) / max(1, s.get('jbEmitted', 1))
    print(f"-- transport: rtt now {s.get('rtt')} avg {s.get('rttAvg')}; jitter buffer avg {jb*1000:.0f} ms, target {s.get('jbTarget',0)/max(1,s.get('jbEmitted',1))*1000:.0f} ms; concealed {s.get('concealed')} of {s.get('samples')} samples; jitter {s.get('jitter')}")
print('-- server-side')
for e in run['server']['events']:
    if e['type'] in ('voice.requested', 'voice.created', 'voice.started', 'voice.closed', 'voice.error', 'voice.protocol_error'): print('  ', e['at'][11:23], e['type'], json.dumps(e.get('data', {}))[:120])
print('  usage:', run['server']['voice'].get('usage'))
