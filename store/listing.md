# Chrome Web Store listing: Focus Player

Everything the Developer Dashboard asks for, ready to paste.

## Live

- Store: https://chromewebstore.google.com/detail/llccfckhklelmbpljegfphphbjaamman (item ID `llccfckhklelmbpljegfphphbjaamman`)
- Demo on YouTube: https://www.youtube.com/watch?v=Nx-_VWGqsh0 (paste it in **Global promo video**)

## Store item

**Name**
Focus Player: Theater mode for any video

**Summary** (132 characters max)
One key turns the video on any website into theater mode. Speed, pop-out, back-to-live and pop-up blocking built in. Free.

**Category**
Functionality & UI. (Alternative: Entertainment.)

**Language**
English

## Description

Plain text: the store shows it as typed.

```
You came for the video, not the page around it.

Press Alt+Shift+F on any website and the video fills the window: no comments, sidebars, cookie bars or autoplaying extras. Press it again and the page is back exactly as it was. It's the site's own player, with nothing else around it.

WHILE YOU WATCH
• Speed: 0.25× to 4×, from the keyboard or the bar on top, remembered for each site.
• Back to live: when a live stream falls behind, one click jumps to the live edge. If a stream freezes, Focus Player catches it up, and restarts the player if it has to. A paused video is always left alone.
• Pop out: picture-in-picture for any video, so it floats while you work.
• Zoom to fill: crop the black bars on ultrawide and tall screens.
• Pick the video: if a page has more than one, point at the one you want. It's remembered for that site.
• Cast-friendly: cast the tab and the TV gets just the video.

KEPT AWAY WHILE YOU WATCH
• Ads and pop-ups: well-known ad and pop-up networks are blocked, and "click anywhere" pop-up tabs are stopped.
• Other sounds: autoplay ads and chat pings go quiet. Your video keeps its sound.

YOUR SITES, YOUR WAY
Leave a site Off and theater mode waits for you to ask. Set it to Button and a small Theater mode button appears when a video does, or to Always and it goes straight in.

Most sites play their video inside a player from another site. One switch, "Control embedded players", lets speed, pop-out, back-to-live and muting work there too; Chrome asks you before it's on.

SHORTCUTS (Option instead of Alt on a Mac)
Alt+Shift+F  theater mode on and off
Alt+Shift+P  pop out
Alt+Shift+.  faster
Alt+Shift+,  slower
Esc  leave theater mode
Change them at chrome://extensions/shortcuts

PRIVATE BY DESIGN
No account, no tracking, no remote code. Nothing leaves your browser. The code is public: github.com/variadic-group/focus-player

Made by Variadic Group. Questions and ideas: hello@variadicgroup.com
```

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
| Promo video 1920×1080, 33 s: the real extension, recorded (upload to YouTube, paste the link in Global promo video) | `store/promo-film.mp4`, thumbnail `store/promo-film-thumbnail.jpg`; rebuild with `python3 store/video/build.py store/promo-film.mp4` (it records fresh footage first) |
| GitHub social preview 1280×640 | `store/social-preview.png` |

The promo film's soundtrack is original, written by `store/video/music.py` and rendered with the FluidR3 General MIDI soundfont (MIT licence); its sounds are Kenney's (CC0). The show in the demo player is generated too (`store/video/stage/scene.html`).
