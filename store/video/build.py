"""Builds the promo film: the real extension recorded (record.py), framed and cut on the
soundtrack's bars (comp.html, stepped by capture.py), the original soundtrack (music.py) with a
sound under each key press and click, one H.264 file at 1920x1080 for YouTube and the store.
   python3 build.py <out.mp4> [takesDir]
With no takesDir it records fresh takes first. Sounds: Kenney (kenney.nl), CC0.
"""
import json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
AUDIO = os.path.join(HERE, 'audio')
OUT = sys.argv[1]
tmp = tempfile.mkdtemp()
takes = sys.argv[2] if len(sys.argv) > 2 else os.path.join(tmp, 'takes')
if len(sys.argv) <= 2:
    subprocess.run([sys.executable, os.path.join(HERE, 'record.py'), takes], check=True)
DUR = 33.0
frames = os.path.join(tmp, 'frames')
subprocess.run([sys.executable, os.path.join(HERE, 'capture.py'), takes, frames, str(DUR)], check=True)
music = os.path.join(tmp, 'music.wav')
subprocess.run([sys.executable, os.path.join(HERE, 'music.py'), music], check=True)

cues = json.load(open(os.path.join(frames, 'cues.json')))
inputs = ['-i', music]
filters = [f'[0:a]volume=0.9,atrim=0:{DUR},afade=t=out:st={DUR - 1.2}:d=1.2[m]']
for i, (t, f, v) in enumerate(cues, start=1):
    inputs += ['-i', os.path.join(AUDIO, f)]
    ms = max(0, int(t * 1000))
    filters.append(f'[{i}:a]aresample=44100,aformat=channel_layouts=stereo,volume={v},adelay={ms}|{ms}[s{i}]')
labels = '[m]' + ''.join(f'[s{i}]' for i in range(1, len(cues) + 1))
filters.append(f'{labels}amix=inputs={len(cues) + 1}:normalize=0:duration=first,loudnorm=I=-16:TP=-1.5:LRA=9,atrim=0:{DUR}[out]')
mix = os.path.join(tmp, 'mix.wav')
subprocess.run(['ffmpeg', '-v', 'error', '-y', *inputs, '-filter_complex', ';'.join(filters), '-map', '[out]', '-ar', '44100', mix], check=True)
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-framerate', '30', '-i', os.path.join(frames, 'f%04d.jpg'), '-i', mix,
                '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
                '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', OUT], check=True)
# A thumbnail: the moment the page turns into just the video.
shutil.copy(os.path.join(frames, 'f0150.jpg'), OUT.replace('.mp4', '-thumbnail.jpg'))
shutil.rmtree(tmp)
print('built', OUT)
