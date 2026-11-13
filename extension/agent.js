// Focus Player — embedded-player reporter. Injected into the frames of the current tab only
// while theater mode is on and "Control embedded players" is allowed. It reports the state of
// the biggest video in its frame; commands are run separately by the background.
(() => {
  if (window.__fpAgent) {
    window.__fpAgent.start();
    return;
  }
  if (window.top === window) {
    window.__fpAgent = { start() {}, stop() {} }; // the page itself is handled by content.js
    return;
  }

  let timer = null;

  function videos(root = document, out = []) {
    root.querySelectorAll('video').forEach((v) => out.push(v));
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) videos(el.shadowRoot, out);
    });
    return out;
  }

  function best() {
    let b = null;
    let ba = 0;
    for (const v of videos()) {
      const r = v.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > ba) { ba = a; b = v; }
    }
    return b;
  }

  // Only live streams (no fixed length) have a live edge to fall behind.
  function lagOf(v) {
    try {
      const s = v.seekable;
      if (!isFinite(v.duration) && s && s.length) {
        const end = s.end(s.length - 1);
        if (isFinite(end)) return end - v.currentTime;
      }
    } catch (_) {}
    return null;
  }

  function report() {
    const v = best();
    const msg = { fp: 'agent-report', hasVideo: !!v };
    if (v) {
      const r = v.getBoundingClientRect();
      Object.assign(msg, {
        w: Math.round(r.width), h: Math.round(r.height), paused: v.paused, ended: v.ended,
        t: v.currentTime, lag: lagOf(v), rs: v.readyState, rate: v.playbackRate,
      });
    }
    chrome.runtime
      .sendMessage(msg)
      .then((res) => { if (res && res.stop) stop(); })
      .catch(() => stop());
  }

  function start() {
    if (timer) return;
    report();
    timer = setInterval(report, 2000);
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  // Clicks inside the player: a new tab right after one is a pop-up (see background.js).
  document.addEventListener('pointerdown', (e) => { if (e.isTrusted) chrome.runtime.sendMessage({ fp: 'page-click' }).catch(() => {}); }, true);

  window.__fpAgent = { start, stop };
  start();
})();
