# Chrome Web Store listing: Focus Player

Everything the Developer Dashboard asks for, ready to paste.

## Store item

**Name**
Focus Player: Theater mode for any video

**Summary** (132 characters max)
Theater mode for every website. One key fills the window with any video. Speed, pop-out, Go live and pop-up blocking built in.

**Category**
Functionality & UI. (Alternative: Entertainment.)

**Language**
English

## Description

Theater mode for every website.

Press Alt+Shift+F on any page with a video, and the video fills the window. Comments, sidebars, banners and autoplay clutter disappear. Press it again, and the page is back exactly as it was.

The things people actually reach for while watching come built in, on every site:

- **Playback speed:** 0.25× to 4×, from the keyboard or the popup, remembered for each site.
- **Picture-in-picture:** pop any video out into a floating window and keep working.
- **Go live:** when a live stream drifts behind, one click jumps back to the live edge.
- **Recover stalled streams:** if a playing live stream gets stuck, Focus Player catches up and, if needed, restarts the player for you. A paused video is always left alone.
- **Block ads & pop-ups:** blocks well-known ad and pop-up networks, and stops the "click anywhere" pop-up tabs while you watch.
- **Mute everything else:** autoplay ads and chat pings go quiet. Your video keeps its sound.
- **Zoom to fill:** crops the black bars on ultrawide and tall screens.
- **Your sites, your way:** set a site to Button (a small Theater mode button appears when a video does) or Always (goes straight in).
- **Pick the video:** if a page has several players, click the one you want. It's remembered for that site.
- **Cast-friendly:** cast the tab, and the TV gets just the video.

It works with ordinary web players and with players embedded from other sites. It's private by design: there's no account, no tracking, no remote code, and nothing leaves your browser.

**Shortcuts**

| Keys | Action |
|---|---|
| Alt+Shift+F | Theater mode |
| Alt+Shift+P | Picture-in-picture |
| Alt+Shift+. | Faster |
| Alt+Shift+, | Slower |
| Esc | Exit theater mode |

Open source (MIT): https://github.com/variadic-group/focus-player

## Single purpose

Focus Player makes the video on the current web page easier to watch: it shows the video full-window and controls its playback (speed, picture-in-picture, live position, recovery). Blocking ads, pop-ups and other sounds serves that same purpose.

## Permission justifications

| Permission | Justification |
|---|---|
| `activeTab` | Act on the tab where you click the toolbar button or press a shortcut, and only then. |
| `scripting` | Show the video full-window and run playback commands (speed, picture-in-picture, go live) in the tab you're using. |
| `storage` | Save your settings, per-site choices (Button/Always, playback speed, picked video) on your computer. |
| `declarativeNetRequest` | Block requests to a fixed list of known ad and pop-up networks (bundled rules, no remote lists). |
| Optional: one site | Only when you set a site to Button or Always, so Focus Player can offer theater mode there automatically. |
| Optional: all sites | Only if you turn on "Control embedded players". Most sites play video inside a player from another domain, and this lets speed, pop-out, Go live, recovery and muting work inside it. It's only used in tabs where you use Focus Player. |

**Remote code:** none. All code ships in the package.

## Data usage (privacy practices tab)

- Collects no user data in any category.
- Doesn't sell or transfer data, use it for unrelated purposes, or use it for creditworthiness.
- Privacy policy URL: https://github.com/variadic-group/focus-player/blob/main/PRIVACY.md

## Graphics

| Asset | File |
|---|---|
| Icon 128×128 | `extension/icons/128.png` |
| Screenshots 1280×800 | `store/screenshot-1.png` … `screenshot-5.png` |
| Small promo tile 440×280 | `store/promo-small.png` |
| Marquee 1400×560 | `store/promo-marquee.png` |
