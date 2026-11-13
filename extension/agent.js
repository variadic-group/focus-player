// Focus Player — Deep mode agent. Injected into the frames of the current tab only
// while Focus Player is on and Deep mode is allowed. Reports the state of the biggest
// video in its frame and carries out play / volume / jump-to-live requests.
(() => {
  if (window.__fpAgent) {
    window.__fpAgent.start();
    return;
  }
  if (window.top === window) {
    window.__fpAgent = { start() {}, stop() {} }; // top page is handled by content.js
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

  function lagOf(v) {
    try {
      const s = v.seekable;
      if (s && s.length) {
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
        muted: v.muted, volume: v.volume, t: v.currentTime, lag: lagOf(v), rs: v.readyState,
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

  chrome.runtime.onMessage.addListener((m) => {
    if (!m || m.fp !== 'agent-cmd') return;
    const v = best();
    if (!v) return;
    switch (m.cmd) {
      case 'play':
        if (v.paused) v.play().catch(() => {});
        else v.pause();
        break;
      case 'mute':
        v.muted = !v.muted;
        break;
      case 'volup':
        v.muted = false;
        v.volume = Math.min(1, Math.round((v.volume + 0.1) * 10) / 10);
        break;
      case 'voldown':
        v.volume = Math.max(0, Math.round((v.volume - 0.1) * 10) / 10);
        break;
      case 'jumplive': {
        const lag = lagOf(v);
        if (lag != null && lag > 3) v.currentTime = v.seekable.end(v.seekable.length - 1) - 2;
        v.play().catch(() => {});
        break;
      }
    }
    setTimeout(report, 150);
  });

  window.__fpAgent = { start, stop };
  start();
})();
