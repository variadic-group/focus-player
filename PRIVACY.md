# Privacy

Focus Player runs entirely in your browser.

- **No servers, accounts, analytics, telemetry or remote code.** The extension makes no network requests of its own.
- **What it stores** in Chrome's local extension storage, on your computer only:
  - your settings
  - sites you set to Button or Always
  - playback speeds you chose per site
  - for sites where you used "Pick a different video", a short description of that player: tag name, id, a few class names, the player's host name and its shape
- **Stalled-picture check:** when Focus Player can't see inside an embedded player, it takes a screenshot of the visible tab while theater mode is on, shrinks it to a 48×27 grey thumbnail and compares it with the previous one. Only the latest thumbnail is kept, in memory.
- **Diagnostics** are built only when you click "Copy diagnostics". They're copied to your clipboard, and nothing is sent anywhere. They include the page's host name, player sizes and host names, and your Focus Player settings.
- **Permissions:**
  - By default, Focus Player acts only on the tab where you click its button or press a shortcut.
  - Site access, for Button/Always sites, and all-site access, for "Control embedded players", are optional. Chrome asks before granting them, and you can remove them any time at `chrome://extensions` → Focus Player → Details.
