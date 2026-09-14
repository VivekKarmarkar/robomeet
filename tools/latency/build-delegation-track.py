import os, sys, json, glob
os.chdir(os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from scipy.io import wavfile
from scipy.signal import resample_poly
SR = 48000
# a request that makes the model call ask_coding_agent, then hellos while the job is pending (the replier answers at ~28 s)
schedule = [(2.0, 'delegate'), (12.0, 'hello'), (16.0, 'stillthere'), (20.0, 'hello'), (24.0, 'stillthere'), (36.0, 'bye')]
END = 40.0
track = np.zeros(int(END * SR), dtype=np.float32); placed = []
for onset, name in schedule:
    sr, data = wavfile.read(f'clips/{name}.wav')
    if data.ndim > 1: data = data.mean(axis=1)
    data = data.astype(np.float32) / (32768.0 if data.dtype == np.int16 else 1.0)
    if sr != SR: data = resample_poly(data, SR, sr).astype(np.float32)
    idx = np.where(np.abs(data) > 0.01 * np.max(np.abs(data)))[0]; data = data[idx[0]:idx[-1] + 1]
    data = data / (np.sqrt(np.mean(data ** 2)) + 1e-9) * 0.08
    start = int(onset * SR); track[start:start + len(data)] += data
    placed.append({'name': name, 'onset': onset, 'end': round(onset + len(data) / SR, 3)})
track = track / np.max(np.abs(track)) * 0.7
wavfile.write('delegation.wav', SR, (track * 32767).astype(np.int16))
json.dump({'sampleRate': SR, 'end': END, 'utterances': placed}, open('delegation.json', 'w'), indent=1)
print(placed)
