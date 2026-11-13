# Focus Player 2.0: project report

## Summary

Focus Player is a site-agnostic Chrome (MV3) extension for watching web video without distractions or risk. It finds the main player on any page, fills the tab with it, hides everything else, and puts an extension-owned **kid lock** layer over it so taps can't reach the website. Around that core it adds:

- per-site **Off / Button / Auto** behaviour
- **auto-fix** for frozen streams
- optional **Deep mode** for embedded players
- **silencing** of other page sounds
- **ad / pop-up blocking**
- a toolbar popup, a settings page and copyable diagnostics

There's no build step and no dependencies. Nothing leaves the browser.

## Design goals

1. **Safe to hand to a child.** No tap while locked reaches the page, and destructive actions need press-and-hold.
2. **Zero fiddling.** No turning things on and off: one shortcut, one-tap Focus buttons on chosen sites, and exit returns to the button.
3. **Works anywhere.** Generic rules only (element types, sizes, shapes, attributes), with no per-site code.
4. **Minimal reach.** By default it acts only on a tab you invoke it on. Wider access is opt-in, per site or for Deep mode.
5. **Leaves the page intact.** Hiding is done by one stylesheet and attribute marks; exiting restores everything instantly.

## Feature inventory

| Area | Feature |
|---|---|
| Focus | Fill-the-tab player; picks the best candidate and avoids ad slots; waits for late players; re-finds swapped players; searches inside web components |
| Kid lock | Extension-iframe shield that engages once playback is detected (start mode lets your click reach the player's play button); Hold, Tap or Off styles; auto-hiding controls and cursor; "Leave site?" guard against redirects |
| Controls | Play, Sound, Volume (native video, or embedded with Deep mode); Full screen; Reload; keyboard shortcuts |
| Parent tools | Change source (auto-locks on to the new player); Pick the video (remembered per site); Next video; toggles; diagnostics |
| Keep playing | Auto-resume when the page or player pauses the video while locked; auto-start paused embedded players (Deep mode) |
| Reliability | Freeze watchdog (currentTime, Deep-mode reports, or 48×27 snapshot diff); jump-to-live, then restart, then back off; stay-live catch-up (>30 s behind) |
| Sound | Mutes non-target media and swallows Web Audio pings: top frame always, other frames with Deep mode; the game keeps its sound |
| Ads & pop-ups | Ad and pop-up network blocklist (declarativeNetRequest, 76 domains); scripted pop-up guard (window.open / scripted `_blank`); pop-up **tab** closer, with real link clicks allowed through |
| Sites | Off / Button / Auto per site via optional per-origin permission and registered content scripts |
| UI | Toolbar popup (status, Focus/Exit, Pick, Change source, site setting, toggles); settings page |

## Architecture

| File | Role |
|---|---|
| `content.js` | Top frame. Candidate scoring, mode machine (off → armed → suggest → focus / pick / wait), watchdog, diagnostics |
| `overlay.*` | Loaded as two extension-origin frames. The **shield** frame is full-window and never resized: kid lock, controls, Pick highlight. The **pill** frame holds the bars used while unlocked: Press play, Unlocked/Tools, Change source, Focus button. Both talk to `content.js` over postMessage, with source and origin checked |
| `background.js` | Service worker. Runs actions; injects the MAIN-world pop-up guard and silencer; closes pop-up tabs; manages the ad ruleset; registers Button/Auto site scripts; takes freeze snapshots; relays Deep-mode messages. Tab state is kept in `storage.session` so it survives the worker sleeping |
| `agent.js` | Deep mode only. Runs in sub-frames, reports the biggest video's state and carries out commands |
| `popup.*`, `options.*` | Popup and settings UI |
| `rules/ads.json` | Static DNR ruleset |

## Testing

`test/run_tests.py` drives real headless Chrome with the extension loaded against local test pages, including ad-only pages, swapped players, a noisy chat widget, a pop-under trap and a seekable "live" clip. **55 of 55 checks pass**. They cover these areas:

- start-then-lock, with and without Deep mode
- keep playing
- kid-lock styles
- chat boxes excluded from player detection
- the Settings tab isn't treated as a pop-up
- ad avoidance
- kid lock (taps never reach the page)
- quick-tap-doesn't-unlock
- clean exit
- Pick + memory
- Change source (same player with a new address, and a replaced player)
- popup Focus/Exit and the site setting
- the Button site's Focus button, plus one-tap re-entry after exit
- pop-under tab closed while a real link still opens
- Auto site
- Deep-mode controls
- in-frame pop-up guard
- site, chat and Web Audio silencing, with the game still audible
- stay-live jump
- frozen embedded player restarts (about 33 s)
- diagnostics
- un-mute on exit
- ad rules match, and the toggle works

## Known limits

- Overlays drawn *inside* a player (its own chat or ads) can't be hidden.
- Some sites refuse to play with ads or pop-ups blocked. There's a toggle for this.
- `<canvas>`-only players aren't detected.
- Chrome offers no API to control casting; extensions can't start or reconnect a cast. Chrome can't AirPlay.
- While the page is visible (Change source, Pick, Focus button), the user is browsing the real site.

## Deliberately out of scope

Focus Player only changes how a page you're already viewing is displayed. It doesn't extract, download, record, pre-load or redistribute streams, and it doesn't hop between a site's alternative sources by itself. Source changes are always the user's click, made easier by **Change source**.

## Roadmap ideas

- Chrome Web Store listing (store copy and screenshots; PRIVACY.md covers the privacy form)
- Run the test suite in GitHub Actions on every pull request (workflow included; it runs on first push)
- An optional per-site exception for the ad blocker
- Firefox and Safari ports. The code is mostly portable; Safari needs Xcode's web-extension converter
- Translations
