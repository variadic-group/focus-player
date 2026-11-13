#!/usr/bin/env python3
"""Builds the Chrome Web Store graphics and README images from real captures of the extension.

    python store/make_assets.py          # needs Playwright + Chromium, ffmpeg, Pillow

Writes store/screenshot-1..5.png (1280x800), store/promo-small.png (440x280),
store/promo-marquee.png (1400x560) and the README images in docs/.
The demo page and video (store/demo/) are original, made for this purpose.
"""
import asyncio, functools, http.server, os, subprocess, sys, tempfile, threading
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'test'))
import run_tests as rt  # reuse the test server + test-permission extension copy

DEMO = os.path.join(ROOT, 'store', 'demo')
OUT = os.path.join(ROOT, 'store')
DOCS = os.path.join(ROOT, 'docs')
CAP = os.path.join(tempfile.mkdtemp(), '')
PORT = 8820
FONT = '/usr/share/fonts/opentype/inter/Inter-{}.otf'
ICON = os.path.join(ROOT, 'extension', 'icons', '128.png')
BG_TOP, BG_BOTTOM = (13, 17, 23), (22, 30, 44)
ACCENT = (61, 220, 132)


def font(weight, size):
    return ImageFont.truetype(FONT.format(weight), size)


def make_demo_video():
    out = os.path.join(DEMO, 'demo.webm')
    if os.path.exists(out): return
    b, m = FONT.format('Bold'), FONT.format('Medium')
    vf = (f"format=yuv420p,drawbox=x=48:y=44:w=92:h=36:color=0xe5484d@1:t=fill,"
          f"drawtext=fontfile={b}:text='LIVE':x=66:y=51:fontsize=22:fontcolor=white,"
          f"drawtext=fontfile={b}:text='Evening Broadcast':x=(w-tw)/2:y=(h-th)/2-30:fontsize=72:fontcolor=white,"
          f"drawtext=fontfile={m}:text='Studio camera 1':x=(w-tw)/2:y=(h/2)+40:fontsize=30:fontcolor=white@0.75,"
          f"drawtext=fontfile={m}:text='%{{pts\\:hms}}':x=w-tw-52:y=50:fontsize=24:fontcolor=white@0.85")
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
                    'gradients=s=1280x720:c0=0x0b1d33:c1=0x16437e:c2=0x1f8a70:c3=0x0b1d33:x0=0:y0=0:x1=1280:y1=720:speed=0.012:d=60:r=30',
                    '-vf', vf, '-c:v', 'libvpx', '-pix_fmt', 'yuv420p', '-b:v', '1200k', '-g', '30', '-t', '60', out], check=True)


async def capture():
    ext = rt.make_test_extension()
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), functools.partial(rt.Handler, directory=DEMO))
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{PORT}'
    async with async_playwright() as p:
        kw = dict(headless=False, viewport={'width': 1280, 'height': 720}, device_scale_factor=1,
                  args=['--headless=new', f'--disable-extensions-except={ext}', f'--load-extension={ext}', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
        if os.environ.get('CHROME'): kw['executable_path'] = os.environ['CHROME']
        ctx = await p.chromium.launch_persistent_context(tempfile.mkdtemp(), **kw)
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        ext_id = sw.url.split('/')[2]
        await sw.evaluate("chrome.storage.local.set({deep:true})")

        async def act(pg, a, wait=1200):
            await sw.evaluate("async ([a,u])=>{const [t]=await chrome.tabs.query({url:u}); return runInTab(t.id,a);}", [a, pg.url.split('?')[0] + '*'])
            await pg.wait_for_timeout(wait)
        def ui(pg): return [f for f in pg.frames if '/ui.html' in f.url][0]

        pg = await ctx.new_page(); await pg.goto(base + '/news.html'); await pg.wait_for_timeout(2500)
        await pg.screenshot(path=CAP + 'before.png')
        await act(pg, 'faster'); await act(pg, 'faster')
        tid = await sw.evaluate("async (u)=>{const [t]=await chrome.tabs.query({url:u}); return t.id}", pg.url + '*')
        pop = await ctx.new_page(); await pop.set_viewport_size({'width': 340, 'height': 640})
        await pop.goto(f'chrome-extension://{ext_id}/popup.html?tab={tid}'); await pop.wait_for_timeout(1500)
        await pop.add_style_tag(content='html,body{overflow:hidden!important}')
        h = await pop.evaluate('document.body.scrollHeight')
        await pop.set_viewport_size({'width': 340, 'height': h}); await pop.wait_for_timeout(200)
        await pop.screenshot(path=CAP + 'popup.png'); await pop.close()
        await pg.bring_to_front()
        await act(pg, 'toggle', 2500)
        await pg.mouse.move(640, 30); await pg.mouse.move(642, 32); await pg.wait_for_timeout(400)
        await pg.screenshot(path=CAP + 'after.png')
        f = ui(pg); b = await (await f.query_selector('#more')).bounding_box()
        await pg.mouse.click(b['x'] + b['width'] / 2, b['y'] + b['height'] / 2); await pg.wait_for_timeout(500)
        await pg.screenshot(path=CAP + 'menu.png')
        await act(pg, 'exit', 500); await pg.close()
        pg = await ctx.new_page(); await pg.goto(base + '/news.html'); await pg.wait_for_timeout(2000)
        await act(pg, 'pick', 1200)
        for x in range(380, 460, 10):
            await pg.mouse.move(x, 420); await pg.wait_for_timeout(90)
        await pg.wait_for_timeout(600)
        await pg.screenshot(path=CAP + 'pick.png')
        await pg.close()

        pg = await ctx.new_page(); await pg.goto(base + '/live.html'); await pg.wait_for_timeout(3000)
        await act(pg, 'toggle', 1000)
        for _ in range(30):
            if await ui(pg).evaluate("document.body.classList.contains('behind')"): break
            await pg.wait_for_timeout(500)
        await pg.mouse.move(640, 30); await pg.mouse.move(642, 32); await pg.wait_for_timeout(400)
        await pg.screenshot(path=CAP + 'live.png')
        await ctx.close()
    srv.shutdown()


# ---------------------------------------------------------------- composition
def gradient(w, h):
    img = Image.new('RGB', (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        d.line([(0, y), (w, y)], fill=tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)))
    glow = Image.new('L', (w, h), 0)
    ImageDraw.Draw(glow).ellipse([w * 0.55, -h * 0.4, w * 1.3, h * 0.6], fill=60)
    glow = glow.filter(ImageFilter.GaussianBlur(120))
    tint = Image.new('RGB', (w, h), (40, 120, 90))
    return Image.composite(tint, img, glow)


def rounded(img, r):
    m = Image.new('L', img.size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, img.size[0] - 1, img.size[1] - 1], r, fill=255)
    out = Image.new('RGBA', img.size); out.paste(img, (0, 0), m)
    return out


def window(shot, w):
    """Put a capture in a simple browser-window frame."""
    h = int(shot.height * w / shot.width)
    shot = shot.resize((w, h), Image.LANCZOS)
    bar = 30
    win = Image.new('RGB', (w, h + bar), (32, 36, 44))
    d = ImageDraw.Draw(win)
    for i, c in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
        d.ellipse([12 + i * 18, 10, 22 + i * 18, 20], fill=c)
    d.rounded_rectangle([90, 6, w - 90, 24], 6, fill=(22, 25, 31))
    win.paste(shot, (0, bar))
    return rounded(win, 12)


def shadowed(canvas, img, xy, r=28, op=150):
    sh = Image.new('RGBA', (img.width + r * 4, img.height + r * 4), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle([r * 2, r * 2, r * 2 + img.width, r * 2 + img.height], 14, fill=(0, 0, 0, op))
    sh = sh.filter(ImageFilter.GaussianBlur(r))
    canvas.alpha_composite(sh, (xy[0] - r * 2, xy[1] - r * 2 + 12))
    canvas.alpha_composite(img, xy)


def headline(canvas, title, sub, y=46):
    d = ImageDraw.Draw(canvas)
    W = canvas.width
    tf, sf = font('Bold', 46), font('Medium', 22)
    tw = d.textlength(title, font=tf)
    d.text(((W - tw) / 2, y), title, font=tf, fill=(245, 247, 250))
    sw_ = d.textlength(sub, font=sf)
    d.text(((W - sw_) / 2, y + 64), sub, font=sf, fill=(160, 172, 190))


def screenshot(n, title, sub, body):
    c = gradient(1280, 800).convert('RGBA')
    headline(c, title, sub)
    body(c)
    c.convert('RGB').save(os.path.join(OUT, f'screenshot-{n}.png'))


def compose():
    L = lambda name: Image.open(CAP + name).convert('RGB')
    before, after, popup, live, pick, menu = (L(x) for x in ['before.png', 'after.png', 'popup.png', 'live.png', 'pick.png', 'menu.png'])

    def s1(c):
        a, b = window(before, 560), window(after, 560)
        shadowed(c, a, (60, 230)); shadowed(c, b, (660, 230))
        d = ImageDraw.Draw(c)
        d.ellipse([616, 380, 664, 428], fill=ACCENT)
        d.polygon([(632, 392), (632, 416), (652, 404)], fill=(5, 46, 22))
        lf = font('SemiBold', 18)
        for text, x in [('Before', 60 + 280), ('After  ·  Alt+Shift+F', 660 + 280)]:
            tw = d.textlength(text, font=lf); d.text((x - tw / 2, 600), text, font=lf, fill=(160, 172, 190))
    screenshot(1, 'Theater mode for every website', 'One key fills the window with any video. Press it again and the page is back.', s1)

    screenshot(2, 'Speed, pop-out and Go live', 'On any player, including ones embedded from other sites. Speed is remembered per site.',
               lambda c: shadowed(c, window(live, 940), (170, 200)))

    def s3(c):
        shadowed(c, window(after, 820), (70, 222))
        k = min(1.0, 560 / popup.height)
        p = rounded(popup.resize((int(popup.width * k), int(popup.height * k)), Image.LANCZOS), 14)
        shadowed(c, p, (1280 - p.width - 70, 200), r=24, op=190)
    screenshot(3, 'Everything in one click', 'Per-site Button or Always · ad & pop-up blocking · mute everything else', s3)

    screenshot(4, 'Picks the right video', 'Skips ads and chat boxes. Or click the one you want; it’s remembered.',
               lambda c: shadowed(c, window(pick, 940), (170, 200)))
    screenshot(5, 'Stays out of your way', 'One slim pill that hides itself. The player’s own controls keep working.',
               lambda c: shadowed(c, window(menu, 940), (170, 200)))

    icon = Image.open(ICON).convert('RGBA')

    # small promo tile 440x280
    t = gradient(440, 280).convert('RGBA')
    t.alpha_composite(icon.resize((72, 72), Image.LANCZOS), (34, 58))
    d = ImageDraw.Draw(t)
    d.text((122, 62), 'Focus Player', font=font('Bold', 34), fill=(245, 247, 250))
    d.text((124, 108), 'Theater mode for every website', font=font('Medium', 17), fill=(160, 172, 190))
    y = 170
    for chip in ['Theater', 'Speed', 'Pop-out', 'Go live']:
        f = font('SemiBold', 14); w = d.textlength(chip, font=f) + 24
        x = 34 if chip == 'Theater' else x
        d.rounded_rectangle([x, y, x + w, y + 32], 16, fill=(32, 40, 52))
        d.text((x + 12, y + 7), chip, font=f, fill=ACCENT if chip == 'Theater' else (220, 226, 235))
        x += w + 8
    t.convert('RGB').save(os.path.join(OUT, 'promo-small.png'))

    # marquee 1400x560
    m = gradient(1400, 560).convert('RGBA')
    m.alpha_composite(icon.resize((96, 96), Image.LANCZOS), (90, 150))
    d = ImageDraw.Draw(m)
    d.text((90, 270), 'Focus Player', font=font('Bold', 64), fill=(245, 247, 250))
    d.text((92, 352), 'Theater mode for every website.', font=font('Medium', 28), fill=(170, 182, 200))
    d.text((92, 396), 'Speed · Pop-out · Go live · Pop-up blocking', font=font('Medium', 22), fill=ACCENT)
    shadowed(m, window(after, 640), (690, 100))
    m.convert('RGB').save(os.path.join(OUT, 'promo-marquee.png'))

    # README images
    before.save(os.path.join(DOCS, 'before.png')); after.save(os.path.join(DOCS, 'theater.png'))
    popup.save(os.path.join(DOCS, 'popup.png')); live.save(os.path.join(DOCS, 'live.png'))
    pick.save(os.path.join(DOCS, 'pick.png')); menu.save(os.path.join(DOCS, 'menu.png'))


if __name__ == '__main__':
    make_demo_video()
    asyncio.run(capture())
    compose()
    print('wrote', sorted(f for f in os.listdir(OUT) if f.endswith('.png')))
