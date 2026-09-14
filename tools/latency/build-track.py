# Assemble the test microphone track: clips placed at fixed onset times, 48 kHz mono 16-bit, exact-zero silence.
import os, sys, json, glob
os.chdir(os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from scipy.io import wavfile
from scipy.signal import resample_poly
SR = 48000
schedule = [  # (onset seconds, clip name)
    (1.0, 'hello'), (3.0, 'hello'), (5.0, 'hello'), (7.0, 'hear'),
    (12.0, 'who'), (22.0, 'session'), (31.0, 'bye'),
]
END = 36.0
track = np.zeros(int(END * SR), dtype=np.float32)
placed = []
for onset, name in schedule:
    sr, data = wavfile.read(f'clips/{name}.wav')
    if data.ndim > 1: data = data.mean(axis=1)
    data = data.astype(np.float32) / (32768.0 if data.dtype == np.int16 else 1.0)
    if sr != SR: data = resample_poly(data, SR, sr).astype(np.float32)
    # trim leading/trailing near-silence so the onset time is the real speech onset
    thr = 0.01 * np.max(np.abs(data))
    idx = np.where(np.abs(data) > thr)[0]
    data = data[idx[0]:idx[-1] + 1]
    data = data / (np.sqrt(np.mean(data ** 2)) + 1e-9) * 0.08  # equal loudness for every clip
    start = int(onset * SR)
    track[start:start + len(data)] += data
    placed.append({'name': name, 'onset': onset, 'end': round(onset + len(data) / SR, 3), 'seconds': round(len(data) / SR, 3)})
peak = np.max(np.abs(track))
track = track / peak * 0.7
wavfile.write('track.wav', SR, (track * 32767).astype(np.int16))
json.dump({'sampleRate': SR, 'end': END, 'utterances': placed}, open('track.json', 'w'), indent=1)
for p in placed: print(p)
