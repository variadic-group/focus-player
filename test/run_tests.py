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
PORT = int(os.environ.get('PORT', '8790'))
BASE = f'http://127.0.0.1:{PORT}'
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

class Handler(http.server.SimpleHTTPRequestHandler):
    """Static server with Range support, so test videos are seekable like a live window."""
    def log_message(self, *a): pass
    def send_head(self):
        rng = self.headers.get('Range'); path = self.translate_path(self.path.split('?')[0])
        if not rng or not os.path.isfile(path): return super().send_head()
        size = os.path.getsize(path); a, b = rng.replace('bytes=', '').split('-')
        a = int(a); b = min(int(b) if b else size - 1, size - 1)
        with open(path, 'rb') as f: f.seek(a); data = f.read(b - a + 1)
        self.send_response(206); self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Accept-Ranges', 'bytes'); self.send_header('Content-Range', f'bytes {a}-{b}/{size}')
        self.send_header('Content-Length', str(len(data))); self.end_headers()
        return io.BytesIO(data)

TGT = "(()=>{const t=document.querySelector('[data-fp-target]');return t?(t.id||t.tagName):null})()"
ON = "document.documentElement.hasAttribute('data-fp-on')"

async def main():
    make_assets()
    ext = make_test_extension()
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), functools.partial(Handler, directory=SITE))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    async with async_playwright() as p:
        kw = dict(headless=False, viewport={'width': 1280, 'height': 720},
                  args=['--headless=new', f'--disable-extensions-except={ext}', f'--load-extension={ext}',
                        '--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
        if os.environ.get('CHROME'): kw['executable_path'] = os.environ['CHROME']
        ctx = await p.chromium.launch_persistent_context(tempfile.mkdtemp(), **kw)
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        ext_id = sw.url.split('/')[2]

        async def tab_id(page):
            return await sw.evaluate("async (u)=>{const [t]=await chrome.tabs.query({url:u}); return t.id}", page.url.split('?')[0] + '*')
        async def act(page, a):
            await sw.evaluate("async ([a,u])=>{const [t]=await chrome.tabs.query({url:u}); await run(t,a);}", [a, page.url.split('?')[0] + '*'])
            await page.wait_for_timeout(800)
        def ov(page):
            fs = [f for f in page.frames if f.url.startswith('chrome-extension://') and 'overlay' in f.url]
            return fs[0] if fs else None
        async def center(page, sel):
            b = await (await ov(page).query_selector(sel)).bounding_box(); return b['x'] + b['width'] / 2, b['y'] + b['height'] / 2
        async def hold(page, sel):
            await page.mouse.move(640, 300); await page.wait_for_timeout(200)
            x, y = await center(page, sel); await page.mouse.move(x, y); await page.mouse.down()
            await page.wait_for_timeout(1400); await page.mouse.up(); await page.wait_for_timeout(600)
        async def tap(page, sel):
            await page.mouse.move(640, 300); await page.wait_for_timeout(150)
            x, y = await center(page, sel); await page.mouse.click(x, y); await page.wait_for_timeout(600)
        async def ui(page):
            o = ov(page)
            return await o.evaluate("[...document.body.classList].filter(c=>c.startsWith('ui-'))[0]") if o else None
        async def tools(page):
            await hold(page, '[data-hold=unlock]')
            await page.mouse.click(*(await center(page, '#toolsBtn'))); await page.wait_for_timeout(500)
        async def storage(obj):
            await sw.evaluate("(o)=>chrome.storage.local.set(o)", obj); await asyncio.sleep(0.6)

        print('\n[1] Ad-only page: waits instead of blowing up an ad, then locks on to the real player')
        pg = await ctx.new_page(); await pg.goto(BASE + '/ads.html'); await pg.wait_for_timeout(400)
        await act(pg, 'toggle')
        check('does not focus an ad-sized frame', not await pg.evaluate(ON))
        check('shows the waiting pill', await ui(pg) == 'ui-wait')
        await pg.wait_for_timeout(6000)
        check('locks on when the player appears', await pg.evaluate(TGT) == 'player', await pg.evaluate(TGT))
        await hold(pg, '[data-hold=exit]')
        check('hold-to-exit restores the page', not await pg.evaluate(ON) and ov(pg) is None)
        await pg.close()

        print('\n[2] Kid lock')
        pg = await ctx.new_page(); await pg.goto(BASE + '/freeze.html'); await pg.wait_for_timeout(800)
        await act(pg, 'toggle')
        for xy in [(640, 360), (100, 100), (1200, 650)]: await pg.mouse.click(*xy)
        await pg.wait_for_timeout(300)
        check('taps never reach the page', await pg.evaluate('__pageClicks') == 0)
        check('window.open blocked', await pg.evaluate("window.open.toString().includes('Focus Player')"))
        await pg.mouse.move(640, 300); x, y = await center(pg, '[data-hold=unlock]'); await pg.mouse.click(x, y); await pg.wait_for_timeout(400)
        check('a quick tap does not unlock', await ui(pg) == 'ui-locked')
        await act(pg, 'toggle')
        check('exit cleans up', await pg.evaluate("document.querySelectorAll('[data-fp-target],[data-fp-ancestor],[data-fp-overlay]').length") == 0
              and not await pg.evaluate("window.open.toString().includes('Focus Player')"))
        await pg.close()

        print('\n[3] Pick the video + remembered per site')
        pg = await ctx.new_page(); await pg.goto(BASE + '/pick.html'); await pg.wait_for_timeout(800)
        await act(pg, 'pick')
        check('pick mode shows the page', await ui(pg) == 'ui-pick' and not await pg.evaluate(ON))
        r = await pg.evaluate("(()=>{const r=document.getElementById('realgame').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()")
        await pg.mouse.move(r[0] - 4, r[1] - 4); await pg.mouse.move(*r); await pg.wait_for_timeout(400)
        await pg.screenshot(path=os.path.join(ROOT, 'docs', 'pick.png'))
        await pg.mouse.click(*r); await pg.wait_for_timeout(800)
        check('tapped player is focused', await pg.evaluate(TGT) == 'realgame')
        await act(pg, 'toggle'); await act(pg, 'toggle')
        check('remembered next time', await pg.evaluate(TGT) == 'realgame')
        await act(pg, 'toggle'); await pg.close()

        print('\n[4] Change source')
        pg = await ctx.new_page(); await pg.goto(BASE + '/sources.html'); await pg.wait_for_timeout(800)
        await act(pg, 'toggle')
        await tools(pg)
        await pg.screenshot(path=os.path.join(ROOT, 'docs', 'tools.png'))
        await pg.mouse.click(*(await center(pg, '[data-cmd=sources]'))); await pg.wait_for_timeout(600)
        check('page comes back with the source pill', await ui(pg) == 'ui-wait' and not await pg.evaluate(ON))
        await pg.screenshot(path=os.path.join(ROOT, 'docs', 'change-source.png'))
        await pg.click('#s2'); await pg.wait_for_timeout(3500)
        check('locks on to the new source (same player, new address)',
              await pg.evaluate(ON) and await pg.evaluate("document.querySelector('[data-fp-target]')?.getAttribute('src')") == 'player.html?s=2')
        await tools(pg); await pg.mouse.click(*(await center(pg, '[data-cmd=sources]'))); await pg.wait_for_timeout(600)
        await pg.click('#s3'); await pg.wait_for_timeout(3500)
        check('locks on to a replaced player', await pg.evaluate(TGT) == 'alt')
        await act(pg, 'toggle'); await pg.close()

        print('\n[5] Toolbar popup')
        pg = await ctx.new_page(); await pg.goto(BASE + '/sources.html'); await pg.wait_for_timeout(800)
        tid = await tab_id(pg)
        pop = await ctx.new_page(); await pop.set_viewport_size({'width': 340, 'height': 620})
        await pop.goto(f'chrome-extension://{ext_id}/popup.html?tab={tid}'); await pop.wait_for_timeout(1200)
        st = await pop.inner_text('#status')
        check('popup sees the video', st.startswith('Video found'), st)
        await pop.screenshot(path=os.path.join(ROOT, 'docs', 'popup.png'))
        await pop.click('#primary'); await pop.wait_for_timeout(900)
        check('popup Focus button focuses the tab', await pg.evaluate(ON))
        await pop.reload(); await pop.wait_for_timeout(1200)
        check('popup then offers Exit', (await pop.inner_text('#primary')).strip() == 'Exit focus')
        await pop.click('#primary'); await pop.wait_for_timeout(800)
        check('popup Exit works', not await pg.evaluate(ON))
        await pop.click('#siteMode [data-v=suggest]'); await pop.wait_for_timeout(4000)
        check('site set to Button shows the Focus button on this page', await ui(pg) == 'ui-suggest', await ui(pg))
        await pg.screenshot(path=os.path.join(ROOT, 'docs', 'focus-button.png'))
        await pop.close(); await pg.close()

        print('\n[6] Button site: Focus button, one-tap re-entry, pop-up tab blocking while browsing')
        pg = await ctx.new_page(); await pg.goto(BASE + '/popups.html'); await pg.wait_for_timeout(3500)
        check('Focus button appears by itself on page load', await ui(pg) == 'ui-suggest', await ui(pg))
        n0 = len(ctx.pages)
        await pg.mouse.click(1150, 650); await pg.wait_for_timeout(1500)
        check('invisible page-sized pop-under link: new tab closed', len(ctx.pages) == n0, f'{len(ctx.pages)} vs {n0}')
        await pg.click('#real'); await pg.wait_for_timeout(1500)
        check('a real link you click still opens its tab', len(ctx.pages) == n0 + 1)
        for p_ in ctx.pages:
            if 'ad.html' in p_.url: await p_.close()
        await pg.bring_to_front()
        await tap(pg, '[data-cmd=focusNow]')
        check('tap Focus video -> focused', await pg.evaluate(ON) and await pg.evaluate(TGT) == 'player')
        await hold(pg, '[data-hold=exit]'); await pg.wait_for_timeout(2600)
        check('after exit, the Focus button is back (one tap to return)', await ui(pg) == 'ui-suggest', await ui(pg))
        await tap(pg, '[data-cmd=dismiss]')
        check('dismiss turns it off for this page', ov(pg) is None)
        await pg.close()

        print('\n[7] Auto site')
        await storage({'siteModes': {BASE: 'auto'}})
        pg = await ctx.new_page(); await pg.goto(BASE + '/sources.html'); await pg.wait_for_timeout(4000)
        check('focuses by itself when the video is there', await pg.evaluate(ON) and await pg.evaluate(TGT) == 'main')
        await act(pg, 'toggle'); await pg.close()
        await storage({'siteModes': {}})

        print('\n[8] Deep mode: controls, stay live, freeze fix, silence, diagnostics')
        await storage({'deep': True})
        pg = await ctx.new_page(); await pg.goto(BASE + '/silence.html'); await pg.wait_for_timeout(2000)
        await act(pg, 'toggle'); await pg.wait_for_timeout(5000)
        emb = [f for f in pg.frames if f.url.endswith('pvideo.html')][0]
        chat = [f for f in pg.frames if f.url.endswith('chat.html')][0]
        check('picks the game, not the chat', await pg.evaluate(TGT) == 'embed')
        check('Play/Volume shown for an embedded player', await ov(pg).evaluate("document.body.classList.contains('has-controls')"))
        check('pop-ups blocked inside the player frame', await emb.evaluate("window.open.toString().includes('Focus Player')"))
        check('site beep muted (top page)', await pg.evaluate("document.getElementById('sitebeep').muted"))
        check('chat audio muted (other frame)', await chat.evaluate("document.getElementById('ding').muted"))
        check('chat Web Audio pings swallowed', await chat.evaluate("AudioScheduledSourceNode.prototype.start.toString().replace(/\\s/g,'')==='function(){}'"))
        check('the game keeps its sound', not await emb.evaluate("document.getElementById('v').hasAttribute('data-fp-hushed')"))
        await tap(pg, '#play'); await pg.wait_for_timeout(2500)
        check('Pause button pauses the embedded video', await emb.evaluate("document.getElementById('v').paused"))
        await tap(pg, '#play'); await pg.wait_for_timeout(1500)
        check('Play resumes it', not await emb.evaluate("document.getElementById('v').paused"))
        t0 = time.time(); jumped = False
        while time.time() - t0 < 25:
            await pg.wait_for_timeout(1000)
            if await emb.evaluate("document.getElementById('v').currentTime") > 80: jumped = True; break
        check('stays live (jumps forward when >30s behind)', jumped)
        loads0 = await pg.evaluate('__loads')
        await pg.evaluate('__freeze=true')
        t0 = time.time()
        while time.time() - t0 < 60:
            await pg.wait_for_timeout(1000)
            if await pg.evaluate('__loads') > loads0: break
        check('frozen embedded player restarts by itself', await pg.evaluate('__loads') > loads0, f'{time.time() - t0:.0f}s')
        await pg.evaluate("window.__freeze=false")
        await pg.wait_for_timeout(2000)
        await tools(pg); await pg.mouse.click(*(await center(pg, '[data-cmd=diag]'))); await pg.wait_for_timeout(800)
        diag = await ov(pg).evaluate("document.getElementById('diagText').value")
        check('diagnostics report', diag.startswith('Focus Player 2.') and 'Deep-mode frames reporting' in diag)
        print('     ' + diag.replace('\n', '\n     '))
        await act(pg, 'toggle'); await pg.wait_for_timeout(800)
        check('exit un-mutes the page', not await pg.evaluate("document.getElementById('sitebeep').muted"))
        await pg.close()
        await storage({'deep': False})

        print('\n[9] Ad-network rules')
        on = await sw.evaluate("chrome.declarativeNetRequest.getEnabledRulesets()")
        check('ad ruleset enabled by default', 'ads' in on)
        hit = await sw.evaluate("chrome.declarativeNetRequest.testMatchOutcome({url:'https://cdn.popads.net/pop.js',type:'script',initiator:'https://example.com',tabId:-1}).then(r=>r.matchedRules.length)")
        miss = await sw.evaluate("chrome.declarativeNetRequest.testMatchOutcome({url:'https://example.com/app.js',type:'script',initiator:'https://example.com',tabId:-1}).then(r=>r.matchedRules.length)")
        check('blocks a known pop-up network, leaves normal sites alone', hit == 1 and miss == 0, f'hit={hit} miss={miss}')
        await storage({'blockAds': False}); await asyncio.sleep(0.5)
        check('toggle off disables the rules', 'ads' not in await sw.evaluate("chrome.declarativeNetRequest.getEnabledRulesets()"))
        await storage({'blockAds': True})

        await ctx.close()
    srv.shutdown()
    passed = sum(1 for _, ok in RESULTS if ok)
    print(f'\n{passed}/{len(RESULTS)} checks passed')
    sys.exit(0 if passed == len(RESULTS) else 1)

if __name__ == '__main__':
    asyncio.run(main())
