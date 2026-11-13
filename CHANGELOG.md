# Changelog

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
