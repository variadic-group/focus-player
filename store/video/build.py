"""Builds the promo film: frames from comp.html, music cut so its strong beats land on the scene
changes, a sound on each change and keystroke, one H.264 file at 1920x1080 for YouTube.
   python3 build.py <scenes.json> <out.mp4>
Music: "Happy Beats Business Moves Vol. 11" by Sascha Ende (ende.app), CC BY 4.0 with attribution
optional. Sounds: Kenney (kenney.nl), CC0.
"""
import json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
AUDIO = os.path.join(HERE, 'audio')
CONFIG, OUT = sys.argv[1], sys.argv[2]
film = json.load(open(CONFIG))
DUR = film['duration']
# The track's first strong beat is at 1.602 s; starting it there puts a beat on every scene change,
# since the scenes are cut on its bars (114.84 bpm, a bar is 2.09 s).
MUSIC_OFFSET = 1.602 - film['scenes'][0]['at']

sfx = []
for i, s in enumerate(film['scenes']):
    sfx.append(('drop_001.ogg' if i == 0 else 'card-slide-1.ogg', s['at'], 0.8 if i == 0 else 0.55))
    if s.get('keys'):
        sfx += [('click_003.ogg', s['at'] + s['typeAt'] + k * s['typeStep'], 0.25) for k in range(len(s['keys']))]
    if s.get('caps'):
        sfx += [('impactSoft_medium_001.ogg', s['at'] + s['typeAt'] + k * s['typeStep'], 0.5) for k in range(len(s['caps']))]
sfx.append(('impactBell_heavy_000.ogg', film['scenes'][-1]['at'] + 0.3, 0.4))

tmp = tempfile.mkdtemp()
mix = os.path.join(tmp, 'mix.wav')
inputs = ['-ss', str(MUSIC_OFFSET), '-t', str(DUR), '-i', os.path.join(AUDIO, 'music.mp3')]
filters = [f'[0:a]volume=0.5,afade=t=in:st=0:d=0.3,afade=t=out:st={DUR - 1.4}:d=1.4[m]']
for i, (f, t, v) in enumerate(sfx, start=1):
    inputs += ['-i', os.path.join(AUDIO, f)]
    ms = max(0, int(t * 1000))
    filters.append(f'[{i}:a]aresample=44100,aformat=channel_layouts=stereo,volume={v},adelay={ms}|{ms}[s{i}]')
labels = '[m]' + ''.join(f'[s{i}]' for i in range(1, len(sfx) + 1))
filters.append(f'{labels}amix=inputs={len(sfx) + 1}:normalize=0:duration=first,loudnorm=I=-16:TP=-1.5:LRA=9,atrim=0:{DUR}[out]')
subprocess.run(['ffmpeg', '-v', 'error', '-y', *inputs, '-filter_complex', ';'.join(filters), '-map', '[out]', '-ar', '44100', mix], check=True)

frames = os.path.join(tmp, 'frames')
subprocess.run([sys.executable, os.path.join(HERE, 'capture.py'), CONFIG, frames], check=True)
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-framerate', '30', '-i', os.path.join(frames, 'f%04d.jpg'), '-i', mix,
                '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
                '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', OUT], check=True)
# A thumbnail for YouTube: the first feature, fully landed.
shutil.copy(os.path.join(frames, f"f{int((film['scenes'][1]['at'] + 1.5) * 30):04d}.jpg"), OUT.replace('.mp4', '-thumbnail.jpg'))
shutil.rmtree(tmp)
print('built', OUT)
