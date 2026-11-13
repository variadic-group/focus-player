#!/usr/bin/env python3
"""End-to-end tests for Focus Player in real (headless) Chrome.

    pip install playwright && python -m playwright install chromium
    python test/run_tests.py                     # uses Playwright's Chromium
    CHROME=/path/to/chrome python test/run_tests.py

Needs ffmpeg on PATH to generate the test video/audio (skipped if already present).
The extension is copied to a temp folder and given test-only permissions
(<all_urls> so no permission prompts, declarativeNetRequestFeedback for rule checks).
"""
import asyncio, functools, http.server, io, json, os, shutil, subprocess, sys, tempfile, threading, time
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, 'test', 'site')
DOCS = os.path.join(ROOT, 'test', 'out')  # screenshots from test runs (not committed)
PORT = int(os.environ.get('PORT', '8790'))
BASE = f'http://127.0.0.1:{PORT}'
STALL_AFTER = 350_000  # bytes of /stall.webm served before the "stream" hangs
RESULTS = []


def check(name, ok, detail=''):
    RESULTS.append((name, bool(ok)))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{('  -- ' + str(detail)) if detail != '' else ''}")


def make_assets():
    clip, beep = os.path.join(SITE, 'clip.webm'), os.path.join(SITE, 'beep.wav')
    if not os.path.exists(clip):
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-t', '90',
                        '-c:v', 'libvpx', '-b:v', '300k', '-g', '25', clip], check=True)
    if not os.path.exists(beep):
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1', beep], check=True)


def make_test_extension():
    d = tempfile.mkdtemp(prefix='fp-ext-')
    shutil.copytree(os.path.join(ROOT, 'extension'), d, dirs_exist_ok=True)
    m = json.load(open(os.path.join(d, 'manifest.json')))
    m['host_permissions'] = ['<all_urls>']
    m['permissions'] = m['permissions'] + ['declarativeNetRequestFeedback']
    json.dump(m, open(os.path.join(d, 'manifest.json'), 'w'), indent=2)
    return d


class Stalling(io.RawIOBase):
    """Serves the first STALL_AFTER bytes, then hangs, like a live stream whose source died."""
    def __init__(self, data):
        self.data, self.pos = data, 0
    def readable(self): return True
    def read(self, n=-1):
        if self.pos >= len(self.data):
            time.sleep(600)
            return b''
        n = len(self.data) - self.pos if n is None or n < 0 else n
        out = self.data[self.pos:self.pos + n]
        self.pos += len(out)
        return out


class Handler(http.server.SimpleHTTPRequestHandler):
    """Static server with Range support (seekable test video) and a stalling stream at /stall.webm."""
    def log_message(self, *a): pass

    def send_head(self):
        path_only = self.path.split('?')[0]
        stall = path_only.endswith('/stall.webm')
        path = self.translate_path(path_only.replace('stall.webm', 'clip.webm'))
        if not os.path.isfile(path): return super().send_head()
        size = os.path.getsize(path)
        rng = self.headers.get('Range')
        a, b = 0, size - 1
        if rng:
            x, y = rng.replace('bytes=', '').split('-')
            a = int(x); b = min(int(y) if y else size - 1, size - 1)
        with open(path, 'rb') as f:
            f.seek(a); data = f.read(b - a + 1)
        self.send_response(206 if rng else 200)
        self.send_header('Content-Type', 'video/webm' if path.endswith('.webm') else self.guess_type(path))
        self.send_header('Accept-Ranges', 'bytes')
        if rng: self.send_header('Content-Range', f'bytes {a}-{b}/{size}')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if stall:
            return Stalling(data[:max(0, STALL_AFTER - a)])
        return io.BytesIO(data)


TGT = "(()=>{const t=document.querySelector('[data-fp-target]');return t?(t.id||t.tagName):null})()"
ON = "document.documentElement.hasAttribute('data-fp-on')"


async def main():
    make_assets()
    os.makedirs(DOCS, exist_ok=True)
    ext = make_test_extension()
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), functools.partial(Handler, directory=SITE))
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    async with async_playwright() as p:
        kw = dict(headless=False, viewport={'width': 1280, 'height': 720},
                  args=['--headless=new', f'--disable-extensions-except={ext}', f'--load-extension={ext}',
                        '--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
        if os.environ.get('CHROME'): kw['executable_path'] = os.environ['CHROME']
        ctx = await p.chromium.launch_persistent_context(tempfile.mkdtemp(), **kw)
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        ext_id = sw.url.split('/')[2]

        def pat(page): return page.url.split('?')[0] + '*'
        async def tab_id(page):
            return await sw.evaluate("async (u)=>{const [t]=await chrome.tabs.query({url:u}); return t.id}", pat(page))
        async def act(page, a, wait=900):
            r = await sw.evaluate("async ([a,u])=>{const [t]=await chrome.tabs.query({url:u}); return runInTab(t.id,a);}", [a, pat(page)])
            await page.wait_for_timeout(wait)
            return r
        def ui_frame(page):
            fs = [f for f in page.frames if f.url.startswith('chrome-extension://') and '/ui.html' in f.url]
            return fs[0] if fs else None
        async def ui(page):
            f = ui_frame(page)
            return await f.evaluate("[...document.body.classList].filter(c=>c.startsWith('ui-'))[0]") if f else None
        async def wait_ui(page, want, secs=12):
            t0 = time.time()
            while time.time() - t0 < secs:
                try:
                    if await ui(page) == want: return True
                except Exception: pass
                await page.wait_for_timeout(300)
            return False
        async def click_ui(page, sel):
            f = ui_frame(page)
            el = await f.query_selector(sel)
            await page.mouse.move(640, 30); await page.wait_for_timeout(120)  # hover the pill so it shows
            b = await el.bounding_box()
            await page.mouse.click(b['x'] + b['width'] / 2, b['y'] + b['height'] / 2)
            await page.wait_for_timeout(500)
        async def storage(obj):
            await sw.evaluate("(o)=>chrome.storage.local.set(o)", obj); await asyncio.sleep(0.6)
        async def popup_for(page, h=720):
            tid = await tab_id(page)
            pop = await ctx.new_page(); await pop.set_viewport_size({'width': 340, 'height': h})
            await pop.goto(f'chrome-extension://{ext_id}/popup.html?tab={tid}'); await pop.wait_for_timeout(1200)
            return pop

        # ------------------------------------------------------------------
        print('\n[1] Ad-only page: waits instead of blowing up an ad, then fills the window with the real player')
        pg = await ctx.new_page(); await pg.goto(BASE + '/ads.html'); await pg.wait_for_timeout(400)
        await act(pg, 'toggle')
        check('does not pick an ad-sized frame', not await pg.evaluate(ON))
        check('shows "Waiting for a video"', await ui(pg) == 'ui-wait')
        await pg.wait_for_timeout(6000)
        check('switches to the player when it appears', await pg.evaluate(ON) and await pg.evaluate(TGT) == 'player')
        check('control pill is shown', await ui(pg) == 'ui-theater')
        await click_ui(pg, '[data-cmd=exit]')
        check('Exit restores the page', not await pg.evaluate(ON) and ui_frame(pg) is None)
        await pg.close()

        print('\n[2] Theater mode: the player stays fully usable')
        pg = await ctx.new_page(); await pg.goto(BASE + '/clutter.html'); await pg.wait_for_timeout(800)
        await pg.screenshot(path=os.path.join(DOCS, 'before.png'))
        pg2 = await ctx.new_page(); await pg2.goto(BASE + '/needsclick.html'); await pg2.wait_for_timeout(800)
        await act(pg2, 'toggle')
        r = await pg2.evaluate("(()=>{const r=document.querySelector('[data-fp-target]').getBoundingClientRect();return [r.width,r.height]})()")
        check('video fills the window', r == [1280, 720], r)
        await pg2.mouse.click(640, 420); await pg2.wait_for_timeout(400)
        check('clicks reach the player (its own play button works)', await pg2.evaluate('__played') == 1)
        check('page pop-ups are blocked in theater mode', await pg2.evaluate("window.open.toString().includes('Focus Player')"))
        await pg2.wait_for_timeout(3500)
        check('pill hides itself after a moment', await ui_frame(pg2).evaluate("document.body.classList.contains('idle')"))
        await pg2.evaluate("document.activeElement && document.activeElement.blur()")  # keyboard back on the page
        await pg2.keyboard.press('Escape'); await pg2.wait_for_timeout(500)
        check('Esc exits theater mode', not await pg2.evaluate(ON))
        await pg2.close(); await pg.close()

        print('\n[3] Pick a different video (remembered per site)')
        pg = await ctx.new_page(); await pg.goto(BASE + '/pick.html'); await pg.wait_for_timeout(800)
        await act(pg, 'pick')
        check('pick mode', await ui(pg) == 'ui-pick')
        r = await pg.evaluate("(()=>{const r=document.getElementById('realgame').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()")
        await pg.mouse.move(r[0] - 4, r[1] - 4); await pg.mouse.move(*r); await pg.wait_for_timeout(400)
        await pg.screenshot(path=os.path.join(DOCS, 'pick.png'))
        await pg.mouse.click(*r); await pg.wait_for_timeout(1200)
        check('clicked player fills the window', await pg.evaluate(TGT) == 'realgame' and await ui(pg) == 'ui-theater')
        await act(pg, 'toggle'); await act(pg, 'toggle', 1500)
        check('remembered next time', await pg.evaluate(TGT) == 'realgame')
        await click_ui(pg, '#more'); await click_ui(pg, '#menu [data-cmd=pick]'); await pg.wait_for_timeout(300)
        r2 = await pg.evaluate("(()=>{const r=document.getElementById('featured-player').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()")
        for dx in range(0, 60, 10):
            await pg.mouse.move(r2[0] + dx, r2[1]); await pg.wait_for_timeout(80)
        await pg.wait_for_timeout(300)
        check('Pick from the ⋯ menu highlights right away', await ui_frame(pg).evaluate("document.getElementById('hl').classList.contains('on')"))
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(600)
        await act(pg, 'exit'); await pg.close()

        print('\n[4] Toolbar popup + Button / Always sites')
        pg = await ctx.new_page(); await pg.goto(BASE + '/sources.html'); await pg.wait_for_timeout(800)
        pop = await popup_for(pg)
        st = await pop.inner_text('#status')
        check('popup sees the video', 'found' in st, st)
        await pop.screenshot(path=os.path.join(DOCS, 'popup.png'))
        await pop.click('#theater'); await pg.wait_for_timeout(1500)
        check('Theater mode button works', await pg.evaluate(ON))
        await pop.reload(); await pop.wait_for_timeout(1200)
        check('popup then offers Exit', 'Exit' in await pop.inner_text('#theater'))
        await pop.click('#theater'); await pg.wait_for_timeout(800)
        check('Exit from the popup works', not await pg.evaluate(ON))
        await pop.click('#siteMode [data-v=suggest]')
        check('Button site: Theater button appears on the page', await wait_ui(pg, 'ui-suggest', 6))
        await pg.screenshot(path=os.path.join(DOCS, 'button.png'))
        await pop.close(); await pg.close()
        pg = await ctx.new_page(); await pg.goto(BASE + '/sources.html')
        check('...and on every page load of that site', await wait_ui(pg, 'ui-suggest', 8))
        await click_ui(pg, '[data-cmd=focusNow]'); await pg.wait_for_timeout(800)
        check('one click: theater mode', await pg.evaluate(ON) and await ui(pg) == 'ui-theater')
        await click_ui(pg, '[data-cmd=exit]')
        check('exit brings the button back', await wait_ui(pg, 'ui-suggest', 6))
        await click_ui(pg, '[data-cmd=dismiss]')
        check('✕ hides it for this page', ui_frame(pg) is None)
        await pg.close()
        await storage({'siteModes': {BASE: 'auto'}})
        pg = await ctx.new_page(); await pg.goto(BASE + '/sources.html'); await pg.wait_for_timeout(4500)
        check('Always site: theater mode by itself', await pg.evaluate(ON) and await pg.evaluate(TGT) == 'main')
        await act(pg, 'exit'); await pg.close()
        await storage({'siteModes': {}})

        print('\n[5] Speed, zoom and pop-out on a page video')
        pg = await ctx.new_page(); await pg.goto(BASE + '/native.html'); await pg.wait_for_timeout(1500)
        pop = await popup_for(pg)
        print('     popup status:', await pop.inner_text('#status'), '| faster enabled:', await pop.is_enabled('#faster'), '| page mode:', await pg.evaluate(ON))
        await pop.click('#faster', timeout=8000); await pop.click('#faster', timeout=8000); await pop.wait_for_timeout(500)
        check('popup speed buttons (no theater needed)', await pg.evaluate("document.getElementById('vid').playbackRate") == 1.5 and '1.5' in await pop.inner_text('#rate'))
        await pop.close()
        await pg.reload(); await pg.wait_for_timeout(1500)
        await act(pg, 'toggle', 2500)
        check('speed is remembered for the site', await pg.evaluate("document.getElementById('vid').playbackRate") == 1.5)
        check('pill shows the speed', (await ui_frame(pg).inner_text('#speed')).startswith('1.5'))
        await pg.mouse.move(640, 30); await pg.wait_for_timeout(300)
        await pg.screenshot(path=os.path.join(DOCS, 'theater.png'))
        await click_ui(pg, '[data-cmd=faster]')
        check('pill + speeds up', await pg.evaluate("document.getElementById('vid').playbackRate") == 1.75)
        await click_ui(pg, '#speed')
        check('click the speed to reset', await pg.evaluate("document.getElementById('vid').playbackRate") == 1)
        await click_ui(pg, '#more'); await pg.wait_for_timeout(300)
        await pg.screenshot(path=os.path.join(DOCS, 'menu.png'))
        await click_ui(pg, '[data-cmd=fill]')
        check('Zoom to fill', await pg.evaluate("getComputedStyle(document.getElementById('vid')).objectFit") == 'cover')
        pop = await popup_for(pg)
        await pop.click('#pip'); await pg.wait_for_timeout(1200)
        pip = await pg.evaluate("!!document.pictureInPictureElement")
        print(f'     (picture-in-picture from the popup: {"opened" if pip else "not available in headless Chrome"})')
        await pop.close()
        await act(pg, 'toggle'); await pg.close()
        await storage({'speeds': {}})

        print('\n[6] Stalled stream recovery (page video, no extra permissions)')
        pg = await ctx.new_page(); await pg.goto(BASE + '/stallnative.html'); await pg.wait_for_timeout(1500)
        await act(pg, 'toggle')
        t0 = time.time(); restarted = False
        while time.time() - t0 < 75:
            await pg.wait_for_timeout(1000)
            if await pg.evaluate('__starts') >= 2: restarted = True; break
        check('a stream that stops loading is restarted', restarted, f'{time.time() - t0:.0f}s')
        await pg.evaluate("document.getElementById('vid').pause()"); await pg.wait_for_timeout(500)
        s0 = await pg.evaluate('__starts'); await pg.wait_for_timeout(25000)
        check('a paused video is left alone', await pg.evaluate('__starts') == s0)
        await act(pg, 'toggle'); await pg.close()

        print('\n[7] Frozen picture without extra permissions: offers Reload')
        pg = await ctx.new_page(); await pg.goto(BASE + '/freeze.html'); await pg.wait_for_timeout(800)
        await act(pg, 'toggle'); await pg.wait_for_timeout(11000)
        await pg.evaluate('__freeze=true')
        check('shows "hasn\'t moved" with a Reload button', await wait_ui(pg, 'ui-frozen', 30))
        await pg.screenshot(path=os.path.join(DOCS, 'frozen.png'))
        await click_ui(pg, '#frozen [data-cmd=reload]'); await pg.wait_for_timeout(1500)
        check('Reload restarts the player', await pg.evaluate('__loads') >= 2)
        await act(pg, 'toggle'); await pg.close()

        print('\n[8] Control embedded players')
        await storage({'deep': True})
        pg = await ctx.new_page(); await pg.goto(BASE + '/silence.html'); await pg.wait_for_timeout(2000)
        await act(pg, 'toggle', 4000)
        emb = [f for f in pg.frames if f.url.endswith('pvideo.html')][0]
        chat = [f for f in pg.frames if f.url.endswith('chat.html')][0]
        check('picks the player, not the chat box', await pg.evaluate(TGT) == 'embed')
        check('chat box is never "another video"', not await ui_frame(pg).evaluate("document.body.classList.contains('multi')"))
        check('pop-ups blocked inside the player', await emb.evaluate("window.open.toString().includes('Focus Player')"))
        check('page sounds muted', await pg.evaluate("document.getElementById('sitebeep').muted"))
        check('chat sounds muted (other frame)', await chat.evaluate("document.getElementById('ding').muted"))
        check('chat Web Audio pings muted', await chat.evaluate("AudioScheduledSourceNode.prototype.start.toString().replace(/\\s/g,'')==='function(){}'"))
        check('your video keeps its sound', not await emb.evaluate("document.getElementById('v').hasAttribute('data-fp-hushed')"))
        await click_ui(pg, '[data-cmd=faster]')
        check('speed works inside the embedded player', await emb.evaluate("document.getElementById('v').playbackRate") == 1.25)
        await act(pg, 'toggle'); await pg.wait_for_timeout(600)
        check('exit un-mutes everything', not await pg.evaluate("document.getElementById('sitebeep').muted"))
        await pg.close()
        await storage({'speeds': {}})

        pg = await ctx.new_page(); await pg.goto(BASE + '/live.html'); await pg.wait_for_timeout(2000)
        await act(pg, 'toggle')
        await wait_ui(pg, 'ui-theater')
        try:
            behind = await asyncio.wait_for(_poll(lambda: ui_frame(pg).evaluate("document.body.classList.contains('behind')")), 20)
        except asyncio.TimeoutError:
            behind = False
        check('live stream: "Go live" appears when behind', behind)
        await pg.mouse.move(640, 30); await pg.wait_for_timeout(300)
        await pg.screenshot(path=os.path.join(DOCS, 'live.png'))
        await click_ui(pg, '#live'); await pg.wait_for_timeout(800)
        lf = [f for f in pg.frames if f.url.endswith('plive.html')][0]
        check('Go live jumps to the live edge', await lf.evaluate("document.getElementById('v').currentTime") > 80)
        await act(pg, 'toggle'); await pg.close()

        pg = await ctx.new_page(); await pg.goto(BASE + '/resizepause.html'); await pg.wait_for_timeout(2000)
        await act(pg, 'toggle', 4500)
        rf = [f for f in pg.frames if f.url.endswith('presize.html')][0]
        check('a player that pauses itself when resized keeps playing', not await rf.evaluate("document.getElementById('v').paused"))
        await act(pg, 'toggle'); await pg.close()

        pg = await ctx.new_page(); await pg.goto(BASE + '/stallembed.html'); await pg.wait_for_timeout(1500)
        await act(pg, 'toggle')
        t0 = time.time(); restarted = False
        while time.time() - t0 < 75:
            await pg.wait_for_timeout(1000)
            if await pg.evaluate('__loads') >= 2: restarted = True; break
        check('a stalled embedded stream is restarted', restarted, f'{time.time() - t0:.0f}s')
        diag = await act(pg, 'diag', 100)
        check('diagnostics', diag and diag.get('diag', '').startswith('Focus Player 3.'))
        await act(pg, 'toggle'); await pg.close()
        await storage({'deep': False})

        print('\n[9] Pop-up tabs from the player are closed in theater mode')
        pg = await ctx.new_page(); await pg.goto(BASE + '/popups.html'); await pg.wait_for_timeout(800)
        await act(pg, 'toggle')
        n0 = len(ctx.pages)
        await pg.mouse.click(640, 400); await pg.wait_for_timeout(1500)
        check('the player still gets your click', await pg.evaluate('__clicks') == 1)
        check('the pop-up tab it opened was closed', len(ctx.pages) == n0, f'{len(ctx.pages)} vs {n0}')
        await click_ui(pg, '#more'); await click_ui(pg, '[data-cmd=settings]'); await pg.wait_for_timeout(1500)
        check('Settings from the pill opens (not mistaken for a pop-up)', any('options.html' in x.url for x in ctx.pages))
        for x in ctx.pages:
            if 'options.html' in x.url:
                await x.set_viewport_size({'width': 900, 'height': 1100}); await x.wait_for_timeout(300)
                await x.screenshot(path=os.path.join(DOCS, 'settings.png'), full_page=True); await x.close()
        await act(pg, 'toggle')
        check('exit cleans up', await pg.evaluate("document.querySelectorAll('[data-fp-target],[data-fp-ancestor],[data-fp-ui]').length") == 0
              and not await pg.evaluate("window.open.toString().includes('Focus Player')"))
        await pg.close()

        print('\n[10] Ad-network rules')
        check('ad ruleset enabled by default', 'ads' in await sw.evaluate("chrome.declarativeNetRequest.getEnabledRulesets()"))
        hit = await sw.evaluate("chrome.declarativeNetRequest.testMatchOutcome({url:'https://cdn.popads.net/pop.js',type:'script',initiator:'https://example.com',tabId:-1}).then(r=>r.matchedRules.length)")
        miss = await sw.evaluate("chrome.declarativeNetRequest.testMatchOutcome({url:'https://example.com/app.js',type:'script',initiator:'https://example.com',tabId:-1}).then(r=>r.matchedRules.length)")
        check('blocks a known pop-up network, leaves normal sites alone', hit == 1 and miss == 0, f'hit={hit} miss={miss}')
        await storage({'blockAds': False}); await asyncio.sleep(0.5)
        check('turning it off disables the rules', 'ads' not in await sw.evaluate("chrome.declarativeNetRequest.getEnabledRulesets()"))
        await storage({'blockAds': True})

        await ctx.close()
    srv.shutdown()
    passed = sum(1 for _, ok in RESULTS if ok)
    print(f'\n{passed}/{len(RESULTS)} checks passed')
    sys.exit(0 if passed == len(RESULTS) else 1)


async def _poll(fn, every=0.5):
    while True:
        try:
            if await fn(): return True
        except Exception:
            pass
        await asyncio.sleep(every)


if __name__ == '__main__':
    asyncio.run(main())
