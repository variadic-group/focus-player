"""Renders the demo show (scene.html) to show.webm, the video the film's demo pages play.
   python3 store/video/stage/stage.py
"""
import base64, os, subprocess, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
OUT = HERE / 'show.webm'
FPS, SECONDS = 30, 48

frames = tempfile.mkdtemp()
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1280, 'height': 720})
    pg.goto((HERE / 'scene.html').as_uri()); pg.wait_for_function('window.ready')
    for i in range(FPS * SECONDS):
        url = pg.evaluate('(t) => { render(t); return document.getElementById("c").toDataURL("image/jpeg", 0.92); }', i / FPS)
        open(os.path.join(frames, f'f{i:04d}.jpg'), 'wb').write(base64.b64decode(url.split(',')[1]))
    b.close()
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-framerate', str(FPS), '-i', os.path.join(frames, 'f%04d.jpg'),
                '-c:v', 'libvpx-vp9', '-b:v', '3M', '-pix_fmt', 'yuv420p', '-g', '30', str(OUT)], check=True)
print('wrote', OUT)
