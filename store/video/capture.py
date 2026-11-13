"""Steps comp.html through the film and writes one JPEG per frame (this repo's tests use Python's
Playwright, so the film does too).
   python3 capture.py <scenes.json> <outDir>
"""
import json, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

config, out = sys.argv[1], sys.argv[2]
film = json.load(open(config))
base = Path(config).resolve().parent
url = lambda f: (base / f).resolve().as_uri()
for s in film['scenes']:
    for k in ('img', 'side'):
        if s.get(k):
            s[k] = url(s[k])
if film.get('icon'):
    film['icon'] = url(film['icon'])
FPS = 30
os.makedirs(out, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(args=['--allow-file-access-from-files', '--force-color-profile=srgb'])
    page = browser.new_page(viewport={'width': 1920, 'height': 1080}, device_scale_factor=1)
    page.add_init_script(f'window.FILM = {json.dumps(film)};')
    page.goto((Path(__file__).resolve().parent / 'comp.html').as_uri(), wait_until='load')
    page.evaluate('() => window.ready')
    for i in range(round(film['duration'] * FPS)):
        page.evaluate('(t) => window.render(t)', i / FPS)
        page.screenshot(path=os.path.join(out, f'f{i:04d}.jpg'), type='jpeg', quality=92)
    browser.close()
