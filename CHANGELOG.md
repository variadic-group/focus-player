# Changelog

## 3.0.0: Theater mode for every website
A ground-up streamline for everyone who watches video in a browser.
- **Removed:** the kid lock, press-and-hold unlock, lock styles, the start-unlocked flow, Change-source mode, auto-resume, and the "Leave site?" guard. The player's own controls now always work.
- **New:** playback speed (0.25–4×, remembered per site, works outside theater mode too), picture-in-picture, a **Go live** button for live streams, and **Zoom to fill**.
- **New:** a slim auto-hiding control pill replaces the big toolbar and overlays.
- **New:** a redesigned popup: Theater mode, Pop out, speed and Pick, the per-site setting (Off / Button / Always), and four plain toggles.
- **Smarter recovery:** only a *playing* stream that stops moving is recovered. Paused videos are left alone. Without embedded-player access, a frozen picture gets a **Reload** offer instead of an automatic restart.
- **Fix:** a player that pauses itself when resized is resumed once.
- **Pop-up tabs:** only tabs opened right after a click in the page or player are closed. Tabs you open yourself are never touched.
- Renamed "Deep mode" to **Control embedded players**.
- Added a Chrome Web Store kit in `store/`.
- New test suite (55 checks), including a stream that stops loading mid-play and an MSE live stream.


## 2.1.0
- **Locks only once the video is playing.** Focusing, picking a video or changing the source now starts unlocked, with a "Press play on the video" bar, so you can click the player's own play button. The kid lock turns on by itself as soon as playback is detected. There's no more hold-to-unlock just to press play.
- **Keeps it playing.** If the page or player pauses the video while it's locked, Focus Player presses play again. With Deep mode, it also starts a paused embedded player for you.
- **Kid lock style:** Hold (default), Tap or Off, in the popup and settings.
- **Next player** never counts chat boxes or other tall side panels.
- **Simpler Tools menu:** Change source, Pick the video, Next player, Reload the player, All settings. Diagnostics and "Forget remembered video" moved to the popup.
- Fixed: **All settings** briefly opened and then closed, because the pop-up tab blocker caught it.
- Hardened the kid lock. The lock layer is now a full-window frame that is never resized, so taps can't slip through to the page for a moment after it engages. A backstop drops any tap that lands on the lock frames.
- 55-check test suite.

## 2.0.0
- **Toolbar popup** with page status, Focus/Exit, Pick the video, Change source, per-site setting and quick toggles. **Alt+Shift+F** still focuses directly.
- **Per-site Off / Button / Auto.** Button sites show a small "Focus video" button whenever a video appears, and exiting brings it back, so there's no turning things on and off.
- **Silence other sounds:** mutes chat beeps, ad audio and Web Audio pings on the page while focused, and in other frames with Deep mode. The video keeps its sound.
- **Ad & pop-up blocking:** a curated ad/pop-up network blocklist (declarativeNetRequest), plus closing pop-up tabs opened by an active page. Real links you click still open.
- New settings page; diagnostics include the new settings.
- End-to-end test suite (42 checks) in `test/`.

## 1.2.0
- Smarter player detection that skips ad-sized and ad-looking frames, with a search inside web components.
- **Pick the video** (tap to choose, remembered per site), **Change source** (auto-locks on to the new player), **Next video**.
- **Deep mode:** controls, exact freeze detection, stay-live catch-up and pop-up blocking inside embedded players.
- Copyable diagnostics. Parent tools moved behind the kid lock.

## 1.1.0
- Waits for a video that hasn't loaded yet, re-finds a player the site swaps out, auto-fixes frozen streams, adds a Reload button.

## 1.0.0
- Fill-the-tab focus mode, kid lock with press-and-hold unlock/exit, pop-up guard, keyboard shortcuts.
