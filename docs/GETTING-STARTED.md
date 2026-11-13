# Getting started with Focus Player

This takes about five minutes the first time. No technical knowledge needed.

## 1. Install

1. Get the files:
   - **Download ZIP** (green **Code** button on GitHub), or
   - the `focus-player-x.y.z.zip` from the latest release.
2. Unzip it somewhere you'll keep it, such as Documents. Don't delete that folder later; Chrome runs the extension from it.
3. In Chrome, open **`chrome://extensions`** (type it in the address bar).
4. Turn on **Developer mode** (switch in the top-right corner).
5. Click **Load unpacked** and choose the folder that contains `manifest.json`. In the GitHub download, that's the **`extension`** folder.
6. Click the puzzle-piece icon in the toolbar, then the **pin** next to Focus Player.

> Updating later: replace the folder's contents with the new version, then click the ↻ arrow on Focus Player in `chrome://extensions`.

## 2. Watch something

1. Open a page with a video and start it playing (or not; Focus Player can wait).
2. Click the **Focus Player** icon → **Focus the video**. Shortcut: **Alt+Shift+F**.
3. The video fills the tab. If it isn't playing yet, a bar at the top says **Press play on the video**. Click the player's play button. Your click goes straight through, with no unlocking needed.
4. Once the video plays, the **kid lock** turns on by itself: taps can't reach the website. If the page pauses the video, Focus Player presses play again.
5. Move the mouse or tap to see the buttons: Play, Sound, Volume, Full screen, Reload.
6. To leave: **press and hold "Hold: exit"** for about a second. A quick tap won't do it, on purpose, so your child can't exit by accident. Prefer one tap? Set **Kid lock → Tap** in the popup. Just want the video big with no lock? Choose **Off**.

## 3. Make your favourite sites one-tap

1. On the site, click the Focus Player icon.
2. Under **On this site**, choose:
   - **Button:** a small **▶ Focus video** button appears whenever a video shows up. Tap it to watch. Exiting brings the button back.
   - **Auto:** goes straight into focus whenever a video starts.
3. Chrome asks to allow access to that one site. Click **Allow**.

## 4. If something isn't right

| Problem | Fix |
|---|---|
| The video was paused when I focused | Press play on the video. You don't need to unlock first, because it stays unlocked until the video plays. With **Deep mode** on, it presses play for you. |
| It focused the wrong thing | Hold **unlock** → **Tools** → **Pick the video myself**, then tap the right player. It remembers. To undo that, use the popup → **Forget it**. |
| You want a different stream on the page | Hold **unlock** → **Tools** → **Change source**, then click the source on the page. It locks on by itself. |
| The picture froze | It fixes itself within about 15–30 seconds, or tap **Reload**. |
| Chat beeps or ads make noise | **Silence other sounds** is on by default. For chat boxes from other sites, turn on **Deep mode** in the popup. |
| The player's own buttons don't respond | That's the kid lock. Hold **unlock**, use the player, then tap **Lock**. |
| A site's video won't play at all | Turn off **Block ads & pop-ups** in the popup. Some sites refuse to play when ads are blocked. |
| Anything else | Toolbar popup → **Copy diagnostics** (at the bottom), and paste it into a GitHub issue. |

## 5. Casting to a TV

1. Focus the video first.
2. Chrome menu (⋮) → **Cast…** → **Sources** → **Cast tab** → pick your TV.
3. If the cast drops, start it again from the same menu. Chrome doesn't let extensions reconnect it.

On a Mac with an Apple TV, use **Screen Mirroring** in Control Center and put Chrome in full screen. An HDMI cable is the most reliable option of all.

## 6. Extra protection for the whole house (optional)

Set your router's DNS to **1.1.1.3** and **1.0.0.3**, Cloudflare's family filter. That blocks malware and adult sites on every device, not just this browser.
