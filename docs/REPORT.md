# Focus Player 3.0: product brief & design report

## 1. Positioning

**Theater mode for every website.**

Video players on the web are fragmented. Theater mode, speed control, picture-in-picture and a live button exist on a handful of large sites, while everything else is a small player buried in clutter. Single-purpose extensions each solve one piece: speed only, picture-in-picture only, a single site only, or blocking only.

Focus Player owns the verb **"just watch it"**. It's one shortcut on any site, and the handful of controls people actually reach for while watching come with it.

- **Promise:** press one key, and the video is all you see. Press it again, and the page is back exactly as it was.
- **Proof points:**
  - works on any site, including embedded players
  - the player's own controls stay usable
  - private by construction: no account, no network calls, no remote code

## 2. Audience

The core is anyone who watches video in a browser tab. Primary segments, from the most frequent "job":

1. **Live watchers** (sports, news, esports): full-window picture, Go live, stall recovery.
2. **Learners** (lectures, courses, tutorials): speed remembered per site, plus pop-out.
3. **Multitaskers:** picture-in-picture for any video.
4. **Tab casters:** the TV shows only the video.
5. **The ad-weary:** pop-ups stopped, ad networks blocked, everything else muted.
6. **Wide or tall screens:** zoom to fill.
7. **Keyboard and accessibility users:** every action has a shortcut, with plain-language UI.

## 3. What we cut (v2 → v3), and why

| Cut | Why |
|---|---|
| Kid lock, press-and-hold unlock, lock styles, start-unlocked flow | It solved a niche case badly: anyone can hold a button. It added friction to every session and hid the player's own controls. |
| Change-source mode | Replaced by the general model. Exit, click anything, and **Button/Always** sites offer theater mode again. |
| Auto-resume of paused video | It can't distinguish your pause from the page's. It's replaced by a targeted fix: if a player pauses itself because theater mode resized it, it's resumed once. |
| "Leave site?" redirect guard | It prompted on legitimate navigation. Pop-up blocking already covers the real threat. |
| Deep-mode jargon, diagnostics and tools buried in menus | Renamed to **Control embedded players**. Diagnostics moved to a quiet footer link. |

## 4. What we added

| Feature | Rationale |
|---|---|
| **Playback speed** (0.25–4×, remembered per site, works outside theater mode) | The single most-requested video control after full-screen. |
| **Picture-in-picture**, including embedded players | Multitasking is the second-largest use. |
| **Go live** button (live streams more than 15 s behind) | A user-initiated live edge. It never fights a deliberate rewind. |
| **Zoom to fill** | Ultrawide and tall screens. |
| **One-shot resume** | Fixes "it paused when I turned it on" for players that pause on resize. |
| **Pop-up tab closing tied to page clicks** | Closes "click anywhere" pop-ups without ever touching tabs you open yourself. |
| **Chrome Web Store kit** | Listing copy, permission justifications, data disclosures and graphics in `store/`. |

## 5. Interaction model

- **One surface on the page:** a slim pill at the top center with Exit · speed · Go live (when relevant) · pop-out · full screen · ⋯. It auto-hides after 2.5 s and reappears on hover. The ⋯ menu holds the rare actions: Pick, Next, Zoom, Reload, Settings.
- **One surface in the toolbar:** the popup. A status line, the big **Theater mode** button, a tool row (Pop out · speed · Pick), the per-site setting (Off · Button · Always), and four plain toggles.
- **Keyboard first:** F for theater, P for pop-out, period and comma for speed, Esc to exit. Four suggested Chrome shortcuts; the rest are user-assignable.
- **Never fight the user.**
  - A paused video is never resumed or "recovered".
  - The page's own controls are never blocked.
  - Only page-initiated pop-up tabs are closed.
  - When Focus Player can't be sure (an embedded player without access), it *offers* a Reload button instead of acting.

## 6. Architecture

| File | Role |
|---|---|
| `content.js` | Top frame. Candidate scoring (size, 16:9 shape, ad sizes and words, chat and portrait exclusion, allow-fullscreen, playing state); modes `off · armed · suggest · wait · pick · theater`; follows swapped players; stream health; diagnostics. |
| `ui.*` | Extension-origin iframe: pill, menu, frozen notice, wait bar, pick overlay, Theater button. |
| `background.js` | Runs **video commands** in whichever frame holds the video. It probes every accessible frame, picks the best video and executes there. It also handles the MAIN-world pop-up guard and sound muting, the pop-up tab closer, the ad ruleset, Button/Always site scripts, the frozen-picture snapshot diff, and command routing. |
| `agent.js` | With *Control embedded players*: reports video state from player frames (time, paused, rate, live lag) and notes clicks for the pop-up tab closer. |
| `popup.*`, `options.*` | Toolbar popup and settings page. |

**Stream health:**

| What Focus Player can see | What it does |
|---|---|
| The video itself (page video, or embedded with access) | Playing but the clock isn't moving for 12 s → jump to live → still stuck after 6 s → restart the player in place → back off after 3 restarts in 3 minutes. |
| Only a picture of the tab (embedded, no access) | An unchanged picture for 15 s → show "hasn't moved" with **Reload player**. It never auto-restarts, because a paused video looks the same. |

## 7. Quality

`test/run_tests.py` drives real headless Chrome with the extension loaded. **55 of 55 checks pass.**

Scenarios covered:

- an ad-only page that later gets a player
- a click-to-play player, to check that controls stay usable
- Esc to exit
- Pick, plus memory
- popup actions
- Button and Always sites
- speed from the popup, remembered speed, pill speed and reset
- zoom to fill
- picture-in-picture
- **a stream that stops loading mid-play**, both as a page video and embedded, and gets restarted
- a paused video that is left alone
- the frozen notice and Reload
- embedded control:
  - choosing the player over the chat box
  - pop-up guard in frames
  - muting page, chat and Web Audio sounds while the video keeps its own
  - speed in frames
  - un-mute on exit
- an **MSE live stream** (Go live)
- a player that pauses on resize
- pop-up tabs from a player closed, while the player still gets the click
- the Settings tab not treated as a pop-up
- clean exit
- the ad rules match, and the toggle works

## 8. Roadmap

- Publish to the Chrome Web Store (assets ready), then Edge Add-ons.
- Firefox port (MV3, mostly portable).
- Per-site ad-blocking exception, for sites that refuse to play with ads blocked.
- Localization.
