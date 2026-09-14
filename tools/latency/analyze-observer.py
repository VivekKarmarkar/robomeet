import os, sys, json, glob
os.chdir(os.path.dirname(os.path.abspath(__file__)))
f = sys.argv[1] if len(sys.argv) > 1 else sorted(glob.glob('obs-run-*.json'))[-1]
run = json.load(open(f)); page = run['observer']['page']; log = page['log']
# observer page clock -> wall clock
wall_of = lambda t: page['wall0'] + (t - page['perf0'])
gum = next((e['t'] for e in log if e['type'] == 'gum.audio'), None)
if gum is None: print('no microphone event in the observer page'); sys.exit(1)
T0 = wall_of(gum)  # wall time when the test track started
rel = lambda wall: (wall - T0) / 1000
rows = []
for e in log:
    if e['type'] in ('mic.onset', 'mic.offset') or e['type'].startswith('robot'):
        t = e['end'] if 'end' in e else e['t']
        rows.append((rel(wall_of(t)), e['type'], e.get('peak', e.get('rms', ''))))
for e in run['observer']['events']: rows.append((rel(e['wall']), 'observer.' + e['type'], e.get('label', '')))
for line in run['attend']:
    try: j = json.loads(line)
    except: continue
    if j['event'] in ('joined', 'voice.start', 'voice.status', 'greeted', 'greet_failed', 'voice.stop', 'meeting.status'):
        import datetime; w = datetime.datetime.fromisoformat(j['at'].replace('Z', '+00:00')).timestamp() * 1000
        rows.append((rel(w), 'attend.' + j['event'], j.get('status') or j.get('trigger') or j.get('humans', '')))
import datetime
for e in run['server']['events']:
    w = datetime.datetime.fromisoformat(e['at'].replace('Z', '+00:00')).timestamp() * 1000
    d = e.get('data', {}) or {}
    if e['type'] == 'transcript': rows.append((rel(w), 'server.' + d.get('role', '?'), d.get('text', '')[:70]))
    elif e['type'] in ('voice.requested', 'voice.created', 'voice.started', 'voice.announced', 'voice.closed', 'voice.error'): rows.append((rel(w), 'server.' + e['type'], ''))
    elif e['type'] == 'meeting.status': rows.append((rel(w), 'server.meeting', d.get('status', '')))
rows.sort(key=lambda r: r[0])
print(f'== {f}\n(seconds after the observer microphone started; test-track utterances: {[(u["name"], u["onset"]) for u in run["track"]["utterances"]]})')
for t, k, v in rows: print(f'  {t:7.2f}  {k:22s} {v}')
print('-- per utterance: mic end -> next robot audio onset heard by the observer')
mics = [(rel(wall_of(e['t'])), rel(wall_of(e['end']))) for e in log if e['type'] == 'mic.offset']
ons = [(rel(wall_of(e['t'])), None) for e in log if e['type'] == 'mic.onset']
robot = sorted(rel(wall_of(e['t'])) for e in log if e['type'].startswith('robot') and e['type'].endswith('.onset'))
sched = run['track']['utterances']
for i, (on, off) in enumerate(zip([o[0] for o in ons], [m[1] for m in mics])):
    nxt = next((r - off for r in robot if r > off - 0.3), None)
    name = sched[i]['name'] if i < len(sched) else '?'
    print(f"  {name:10s} onset {on:6.2f} end {off:6.2f}  -> robot audio {'%.2f' % nxt if nxt is not None else '-':>6s}")
