"""Writes and renders the films' soundtrack: an original, warm and lightly upbeat piece at 108 bpm,
14 bars and a ring-out, laid out on the films' cuts (a bar is 2.222 s; the groove lands on bar 2).
   python3 music.py <out.wav>
Needs mido (pip) and FluidSynth with the FluidR3 General MIDI soundfont (MIT licence).
"""
import subprocess, sys, tempfile, os
import mido

BPM, TPB = 108, 480
BAR = 4 * TPB
SF2 = '/usr/share/sounds/sf2/FluidR3_GM.sf2'

# D major: I, V/3, vi, IV, one chord a bar.
CHORDS = [
    {'bass': 38, 'keys': [62, 66, 69, 76], 'arp': [50, 57, 62, 66, 69, 66, 62, 57]},   # D(add9)
    {'bass': 37, 'keys': [61, 64, 69, 73], 'arp': [49, 57, 61, 64, 69, 64, 61, 57]},   # A/C#
    {'bass': 35, 'keys': [62, 66, 71, 74], 'arp': [47, 54, 59, 62, 66, 62, 59, 54]},   # Bm
    {'bass': 31, 'keys': [62, 67, 71, 74], 'arp': [43, 50, 55, 59, 62, 59, 55, 50]},   # G
]
# The hook, in eighths (None rests), one line per bar: answers itself over two cycles.
HOOK = [
    [81, None, 78, 81, 83, None, 81, 78],
    [76, None, None, 73, 76, None, 78, None],
    [78, None, 74, 78, 81, None, 78, 74],
    [79, None, 78, 76, 74, None, None, None],
]
CH = dict(keys=0, gtr=1, bass=2, vib=3, pad=4, fx=5, drums=9)
PROG = dict(keys=4, gtr=24, bass=33, vib=11, pad=89, fx=119)

events = []  # (tick, channel, note, velocity, length)
def note(ch, n, at, length, vel): events.append((int(at), CH[ch], n, int(vel), int(length)))
def hit(n, at, vel): note('drums', n, at, TPB // 4, vel)

for bar in range(15):
    c = CHORDS[bar % 4]
    t0 = bar * BAR
    if bar == 14:  # the last chord, left to ring
        for n in [50, 57, 62, 66, 69, 76]: note('keys', n, t0, BAR * 2, 70)
        note('bass', 38, t0, BAR * 2, 90); note('vib', 86, t0, BAR * 2, 70); note('vib', 81, t0 + TPB // 2, BAR * 2, 50)
        hit(49, t0, 70)
        break
    full = 2 <= bar <= 9 or bar >= 12
    soft = bar < 2
    # Rhodes: chord on 1, a push on the "and" of 2
    kv = 58 if soft else 72
    for n in c['keys']:
        note('keys', n, t0, TPB * 1.5, kv)
        note('keys', n, t0 + TPB * 2.5, TPB * 1.4, kv - 8)
    # nylon guitar arpeggio in eighths
    for i, n in enumerate(c['arp']):
        note('gtr', n, t0 + i * TPB // 2, TPB * 0.9, (52 if soft else 64) + (8 if i % 4 == 0 else 0))
    # pad under the breakdown and the end
    if bar >= 10:
        for n in c['keys'][:3]: note('pad', n - 12, t0, BAR, 50 if bar < 12 else 42)
    if full or bar in (10, 11):
        # bass: root, a passing octave, the next chord approached
        b = c['bass']
        for at, n, l in [(0, b, 1.4), (1.5, b, 0.4), (2, b + 12, 0.45), (2.5, b, 1.0), (3.5, b + 7, 0.45)]:
            note('bass', n, t0 + at * TPB, l * TPB, 88 if at == 0 else 74)
    if full:
        for beat in range(4):
            hit(36, t0 + beat * TPB, 96 if beat % 2 == 0 else 0)
            if beat in (1, 3): hit(39, t0 + beat * TPB, 78); hit(38, t0 + beat * TPB, 40)
        hit(36, t0 + 2.75 * TPB, 62)
        for e in range(8): hit(42, t0 + e * TPB // 2, 58 if e % 2 else 44)
    if bar >= 1 and bar not in (14,):
        for s in range(16): hit(82, t0 + s * TPB // 4, 34 + (16 if s % 4 == 2 else 0))
    if bar == 11:  # the build back in
        for e in range(4, 8): hit(36, t0 + e * TPB // 2, 60 + e * 6)
        for s in range(8, 16): hit(38, t0 + s * TPB // 4, 30 + s * 4)
    if bar in (2, 12): hit(49, t0, 92)
    if bar == 1: note('fx', 60, t0 + TPB, BAR - TPB, 70)   # a reverse cymbal into the groove
    if 4 <= bar <= 9 or bar >= 12:
        for i, n in enumerate(HOOK[bar % 4]):
            if n: note('vib', n, t0 + i * TPB // 2, TPB * 0.9, 84 if i == 0 else 70)

mid = mido.MidiFile(ticks_per_beat=TPB)
tr = mido.MidiTrack(); mid.tracks.append(tr)
tr.append(mido.MetaMessage('set_tempo', tempo=mido.bpm2tempo(BPM)))
for k, ch in CH.items():
    if k in PROG: tr.append(mido.Message('program_change', channel=ch, program=PROG[k]))
tr.append(mido.Message('control_change', channel=CH['pad'], control=7, value=70))
tr.append(mido.Message('control_change', channel=CH['gtr'], control=10, value=40))
tr.append(mido.Message('control_change', channel=CH['vib'], control=10, value=84))
for ch in CH.values(): tr.append(mido.Message('control_change', channel=ch, control=91, value=60))
msgs = []
for at, ch, n, v, l in events:
    if v <= 0: continue
    msgs.append((at, 1, mido.Message('note_on', channel=ch, note=n, velocity=min(127, v))))
    msgs.append((at + l, 0, mido.Message('note_off', channel=ch, note=n, velocity=0)))
msgs.sort(key=lambda m: (m[0], m[1]))
last = 0
for at, _, m in msgs:
    tr.append(m.copy(time=at - last)); last = at

out = sys.argv[1]
tmp = tempfile.mkdtemp()
mid.save(os.path.join(tmp, 'theme.mid'))
subprocess.run(['fluidsynth', '-ni', '-g', '0.7', '-r', '44100', '-F', os.path.join(tmp, 'raw.wav'), SF2, os.path.join(tmp, 'theme.mid')],
               check=True, capture_output=True)
# a little air on top and glue on the whole
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', os.path.join(tmp, 'raw.wav'), '-af',
                'highshelf=f=8000:g=2,acompressor=threshold=-18dB:ratio=2.5:attack=20:release=200,atrim=0:36,afade=t=out:st=33.5:d=2.5',
                out], check=True)
print('wrote', out)
