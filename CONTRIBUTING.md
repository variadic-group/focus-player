# Contributing

Thanks for helping! A few notes:

- **No build step, no dependencies.** The extension is plain JavaScript in `extension/`. Load it unpacked and click ↻ after changes.
- **Keep it site-agnostic.** Focus Player must work by generic rules: element types, sizes, shapes, attributes. Please don't add per-site rules or selectors for particular websites.
- **Keep it private.** No network requests, analytics or remote code.
- **Run the tests** before opening a PR: `python test/run_tests.py` (see README). Add a test page under `test/site/` for new behaviour.
- **Bug reports:** Unlock → Tools → **Copy diagnostics** and paste the report into the issue. It contains the page's host name and player sizes. Remove anything you don't want to share.
- **Ad list (`extension/rules/ads.json`):** only add domains that are clearly ad, pop-up or ad-tracking networks, one per entry. Explain each addition in the PR.
