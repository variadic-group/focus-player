# Privacy

Focus Player runs entirely in your browser.

- **No servers, accounts, analytics, telemetry or remote code.** The extension never makes a network request of its own.
- **What it stores** (in Chrome's local extension storage, on your computer only):
  - your settings
  - the sites you set to Button or Auto
  - for sites where you used "Pick the video", a short description of that player: tag name, id, a few class names, the player's host name and its shape
- **Freeze detection without Deep mode** takes a screenshot of the visible tab, shrinks it to a 48×27 grey thumbnail and compares it with the previous one, then throws both away. Only the latest thumbnail is kept, and only in memory.
- **Diagnostics** are built only when you press "Copy diagnostics". They're copied to your clipboard and shown to you; nothing is sent anywhere. They include the page's host name, player sizes and host names, and your Focus Player settings.
- **Permissions:**
  - By default, Focus Player can act only on the tab where you click it or press a shortcut.
  - Site access for Button/Auto sites and all-site access for Deep mode are optional. Chrome asks you before granting them, and you can remove them at any time in `chrome://extensions` → Focus Player → Details.
