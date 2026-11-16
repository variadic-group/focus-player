"""Records the film's footage: the real extension working on the demo pages in store/video/stage,
captured frame by frame through Chrome's screencast and laid down at 30 frames a second.
   python3 store/video/record.py <outDir>
Each take is <outDir>/<take>/f0000.jpg... plus <take>.json with the cursor's path and the moments
the film cuts on. Needs Playwright's Chromium (the tests use it too).
"""
import asyncio, base64, functools, http.server, json, os, shutil, sys, tempfile, threading, time
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'test'))
import run_tests as rt  # the test server and the test-permission copy of the extension

STAGE = Path(__file__).resolve().parent / 'stage'
if not (STAGE / 'show.webm').exists():  # the demo show is generated, not kept in git
    import subprocess; subprocess.run([sys.executable, str(STAGE / 'stage.py')], check=True)
OUT = Path(sys.argv[1])
PORT = 8831
FPS = 30
VIEW = {'width': 1920, 'height': 1080}
ZOOM = 4 / 3   # Chrome's page zoom: the page and the extension's own controls drawn larger, still 1920x1080


class Take:
    """One continuous recording of a page; frames arrive only when something changes."""
    def __init__(self, ctx, page, name):
        self.ctx, self.page, self.name, self.frames, self.marks, self.cursor = ctx, page, name, [], {}, []

    async def start(self):
        self.cdp = await self.ctx.new_cdp_session(self.page)
        self.cdp.on('Page.screencastFrame', self._frame)
        await self.cdp.send('Page.startScreencast', {'format': 'jpeg', 'quality': 92, 'maxWidth': 1920, 'maxHeight': 1080})
        self.t0 = time.monotonic()

    def _frame(self, f):
        self.frames.append((time.monotonic() - self.t0, f['data']))
        asyncio.ensure_future(self.cdp.send('Page.screencastFrameAck', {'sessionId': f['sessionId']}))

    def now(self): return time.monotonic() - self.t0
    def mark(self, k): self.marks[k] = round(self.now(), 3)

    async def move(self, x, y, secs=0.5, steps=14):
        """Moves the real mouse, and remembers the path so the film can draw a cursor on it."""
        x0, y0 = self.cursor[-1][1:] if self.cursor else (x, y)
        for i in range(1, steps + 1):
            k = i / steps; k = k * k * (3 - 2 * k)
            px, py = x0 + (x - x0) * k, y0 + (y - y0) * k
            await self.page.mouse.move(px * ZOOM, py * ZOOM)
            self.cursor.append((round(self.now(), 3), px * ZOOM, py * ZOOM))
            await asyncio.sleep(secs / steps)

    async def click(self, x, y):
        await self.move(x, y)
        self.mark(f'click{len([k for k in self.marks if k.startswith("click")])}')
        await self.page.mouse.click(x * ZOOM, y * ZOOM)

    async def stop(self):
        await self.cdp.send('Page.stopScreencast')
        end = self.now()
        d = OUT / self.name
        shutil.rmtree(d, ignore_errors=True); d.mkdir(parents=True)
        j = 0
        for i in range(int(end * FPS)):
            t = i / FPS
            while j + 1 < len(self.frames) and self.frames[j + 1][0] <= t: j += 1
            (d / f'f{i:04d}.jpg').write_bytes(base64.b64decode(self.frames[j][1]))
        json.dump({'frames': int(end * FPS), 'marks': self.marks, 'cursor': self.cursor}, open(OUT / f'{self.name}.json', 'w'), indent=1)
        print(f'{self.name}: {end:.1f}s, {len(self.frames)} captured frames, marks {self.marks}')


async def main():
    ext = rt.make_test_extension()
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), functools.partial(rt.Handler, directory=str(STAGE)))
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f'http://dailystream.example:{PORT}'
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            tempfile.mkdtemp(), headless=False, viewport=VIEW, device_scale_factor=1,
            args=['--headless=new', f'--disable-extensions-except={ext}', f'--load-extension={ext}', '--no-sandbox',
                  '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars',
                  '--host-resolver-rules=MAP dailystream.example 127.0.0.1'])
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        ext_id = sw.url.split('/')[2]
        await sw.evaluate("chrome.storage.local.set({deep:true})")

        async def act(pg, a):
            await sw.evaluate("async ([a,u])=>{const [t]=await chrome.tabs.query({url:u}); return runInTab(t.id,a);}", [a, pg.url.split('?')[0] + '*'])
        async def zoom(pg):
            await sw.evaluate("async ([u,z])=>{const t=(await chrome.tabs.query({})).find(t=>(t.url||t.pendingUrl||'').startsWith(u)); await chrome.tabs.setZoom(t.id,z);}", [pg.url.split('?')[0], ZOOM])
            await asyncio.sleep(0.3)
        def ui(pg): return next((f for f in pg.frames if '/ui.html' in f.url), None)
        async def ui_box(pg, sel):
            el = await ui(pg).query_selector(sel)
            return await el.bounding_box()

        # 1. The page as it is, then one key, then faster.
        pg = await ctx.new_page()
        await pg.goto('about:blank')
        await pg.goto(base + '/news.html'); await zoom(pg)
        await pg.goto(base + '/news.html?again')
        tk = Take(ctx, pg, 'news'); await tk.start()
        await pg.reload()
        await tk.move(1100, 620, 0.01, 1)
        await asyncio.sleep(4.2)
        tk.mark('toggle'); await act(pg, 'toggle')
        await asyncio.sleep(1.6)
        await tk.move(720, 60, 0.6)          # the pill shows when the mouse comes near the top
        await asyncio.sleep(1.4)
        tk.mark('faster1'); await act(pg, 'faster')
        await asyncio.sleep(1.1)
        tk.mark('faster2'); await act(pg, 'faster')
        await asyncio.sleep(1.1)
        tk.mark('faster3'); await act(pg, 'faster')
        await asyncio.sleep(2.0)
        tk.mark('exit'); await act(pg, 'exit')
        await asyncio.sleep(2.0)
        await tk.stop()
        tid = await sw.evaluate("async (u)=>{const [t]=await chrome.tabs.query({url:u}); return t.id}", pg.url.split('?')[0] + '*')

        # 2. The extension's panel, its switches flipped by hand.
        pop = await ctx.new_page(); await pop.set_viewport_size({'width': round(340 * ZOOM), 'height': 900})
        await pop.goto(f'chrome-extension://{ext_id}/popup.html?tab={tid}'); await asyncio.sleep(1.0)
        await pop.add_style_tag(content=f'html,body{{overflow:hidden!important}} html{{zoom:{ZOOM}}}')  # its own page: CSS zoom does what Chrome's zoom does
        h = await pop.evaluate('document.documentElement.getBoundingClientRect().height')
        await pop.set_viewport_size({'width': round(340 * ZOOM), 'height': round(h)}); await asyncio.sleep(0.3)
        toggles = await pop.evaluate("""[...document.querySelectorAll('input[type=checkbox]')].map(e=>{
            const r=(e.closest('label')||e).getBoundingClientRect();return [r.right-24,r.top+r.height/2,e.id||e.name||'']})""")
        toggles = [(x / ZOOM, y / ZOOM, n) for x, y, n in toggles]   # CSS zoom already scaled these; Take works in unzoomed px
        for x, y, _ in toggles[:3]:             # start with them off, so the film can switch them on
            await pop.mouse.click(x * ZOOM, y * ZOOM); await asyncio.sleep(0.2)
        tk = Take(ctx, pop, 'panel'); await tk.start()
        await tk.move(170, h - 40, 0.01, 1); await asyncio.sleep(0.9)
        for x, y, _ in toggles[:3]:
            await tk.click(x, y); await asyncio.sleep(0.45)
        await asyncio.sleep(1.5)
        await tk.stop(); await pop.close()
        await pg.close()

        # 3. Fallen behind on a live stream, and back to live.
        pg = await ctx.new_page(); await pg.goto(base + '/live.html'); await zoom(pg); await asyncio.sleep(2)
        await act(pg, 'toggle')
        for _ in range(40):
            f = ui(pg)
            if f and await f.evaluate("document.body.classList.contains('behind')"): break
            await asyncio.sleep(0.5)
        await act(pg, 'reset-speed')
        tk = Take(ctx, pg, 'live'); await tk.start()
        await tk.move(1000, 500, 0.01, 1)
        await tk.move(720, 60, 0.6); await asyncio.sleep(1.4)
        el = await ui(pg).query_selector('#live'); b = await el.bounding_box()   # in viewport px
        await tk.click((b['x'] + b['width'] / 2) / ZOOM, (b['y'] + b['height'] / 2) / ZOOM)
        await asyncio.sleep(0.4)
        if await ui(pg).evaluate("document.body.classList.contains('behind')"):
            print('the click missed Go live; using the command'); await act(pg, 'jumplive')
        await asyncio.sleep(2.6)
        await tk.stop()
        await ctx.close()
    srv.shutdown()

asyncio.run(main())
