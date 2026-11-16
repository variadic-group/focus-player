"""Steps comp.html through the film and writes one JPEG per frame.
   python3 capture.py <takesDir> <outDir> [seconds]
"""
import asyncio, json, os, sys
from pathlib import Path
from playwright.async_api import async_playwright

HERE = Path(__file__).resolve().parent
TAKES, OUT = Path(sys.argv[1]).resolve(), sys.argv[2]
SECONDS = float(sys.argv[3]) if len(sys.argv) > 3 else 33.0
FPS = 30

data = {'base': TAKES.as_uri(), 'icon': (HERE.parents[1] / 'extension' / 'icons' / '128.png').as_uri()}
for j in TAKES.glob('*.json'):
    data[j.stem] = json.load(open(j))
from PIL import Image
data['panel']['height'] = Image.open(TAKES / 'panel' / 'f0000.jpg').height


async def main():
    os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--allow-file-access-from-files', '--force-color-profile=srgb'])
        pg = await b.new_page(viewport={'width': 1920, 'height': 1080})
        await pg.add_init_script(f'window.TAKES = {json.dumps(data)};')
        await pg.goto((HERE / 'comp.html').as_uri())
        await pg.wait_for_function('window.ready')
        json.dump(await pg.evaluate('window.CUES'), open(os.path.join(OUT, 'cues.json'), 'w'))
        for i in range(round(SECONDS * FPS)):
            await pg.evaluate('(t) => window.render(t)', i / FPS)
            await pg.screenshot(path=os.path.join(OUT, f'f{i:04d}.jpg'), type='jpeg', quality=92)
        await b.close()

asyncio.run(main())
