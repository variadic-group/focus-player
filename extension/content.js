// Focus Player — content script (isolated world, top frame only).
// Site-agnostic: finds the main video player on whatever page it runs on.
(() => {
  if (window.__focusPlayer) return;

  const VERSION = chrome.runtime.getManifest().version;
  const EXT_ORIGIN = new URL(chrome.runtime.getURL('')).origin;
  const OVERLAY_URL = chrome.runtime.getURL('overlay.html');
  const STYLE_ID = '__fp-style';
  const MIN_W = 200;
  const MIN_H = 120;

  // Auto-fix tuning
  const TICK_MS = 3000; // freeze check interval
  const FROZEN_MS = 15000; // picture unchanged this long = frozen
  const GRACE_MS = 12000; // time a restarted player gets to come back
  const MAX_FIXES = 3; // auto-restarts allowed per window before backing off
  const FIX_WINDOW_MS = 180000;
  const LIVE_LAG_S = 30; // fall further behind live than this = jump forward
  const AGENT_FRESH_MS = 7000;

  // Common ad slot sizes (IAB). A frame this size is almost never the game.
  const AD_SIZES = [
    [300, 250], [336, 280], [728, 90], [970, 90], [970, 250], [160, 600], [300, 600],
    [320, 50], [320, 100], [468, 60], [250, 250], [200, 200], [120, 600], [300, 50], [300, 100],
  ];
  const AD_WORDS =
    /(^|[\/._\-?=&#\s])(ads?|adv|advert\w*|banner\w*|sponsor\w*|promo\w*|popunder|doubleclick|googlesyndication|adserver|adservice|taboola|outbrain|prebid)([\/._\-?=&#\s]|$)/;
  const PLAYER_WORDS = /(embed|player|stream|live|watch|video|hls|jwplayer|clappr|videojs|plyr)/;

  const PAGE_CSS = `
html[data-fp-on] { background:#000 !important; overflow:hidden !important; }
html[data-fp-on] body { background:transparent !important; overflow:hidden !important; }
html[data-fp-on] body * { visibility:hidden !important; }
html[data-fp-on] [data-fp-target], html[data-fp-on] [data-fp-target] * { visibility:visible !important; }
html[data-fp-on] [data-fp-target] { TARGET }
html[data-fp-on] [data-fp-ancestor] { ANCESTOR }`;
  const SHADOW_CSS = `
[data-fp-target], [data-fp-target] * { visibility:visible !important; }
[data-fp-target] { TARGET }
[data-fp-ancestor] { ANCESTOR }`;
  const TARGET_RULES = `position:fixed !important; inset:0 !important; top:0 !important; left:0 !important;
  right:auto !important; bottom:auto !important; width:100vw !important; height:100vh !important;
  max-width:none !important; max-height:none !important; min-width:0 !important; min-height:0 !important;
  margin:0 !important; padding:0 !important; border:0 !important; border-radius:0 !important;
  transform:none !important; opacity:1 !important; z-index:2147483646 !important;
  background:#000 !important; object-fit:contain !important; display:block !important;`;
  const ANCESTOR_RULES = `transform:none !important; filter:none !important; perspective:none !important;
  contain:none !important; will-change:auto !important; backdrop-filter:none !important;
  clip-path:none !important; -webkit-mask:none !important; mask:none !important;
  content-visibility:visible !important;`;
  const fill = (css) => css.replace('TARGET', TARGET_RULES).replace('ANCESTOR', ANCESTOR_RULES);

  // mode: off | armed (auto-on, waiting silently) | wait (pill showing) | pick | focus
  const state = {
    mode: 'off',
    locked: true,
    menuOpen: false,
    visualsOn: false,
    target: null,
    prevTarget: null,
    marked: [],
    shadowStyles: [],
    candidates: [],
    idx: 0,
    lastList: [],
    overlay: null,
    videoListeners: null,
    observer: null,
    observerTimer: null,
    lostSince: 0,
    waitReason: 'loading',
    waitTimer: null,
    waitStart: 0,
    pending: null,
    baseline: new Map(),
    agents: new Map(),
    agentAsk: 0,
  };

  const wd = {
    timer: null,
    stillSince: 0,
    lastT: null,
    stage: 0,
    fixes: [],
    graceUntil: 0,
    busy: false,
    userPaused: false,
    hinted: false,
    lastLiveJump: 0,
    lastDiff: null,
    lastVia: '',
  };

  let settings = { deep: false, autofix: true, silence: true, blockAds: true, siteModes: {}, picks: {} };
  const normalize = () => {
    settings.autofix = settings.autofix !== false;
    settings.silence = settings.silence !== false;
    settings.blockAds = settings.blockAds !== false;
    settings.siteModes = settings.siteModes || {};
  };
  const settingsReady = chrome.storage.local
    .get(['deep', 'autofix', 'silence', 'blockAds', 'siteModes', 'picks'])
    .then((s) => {
      settings = { ...settings, ...s };
      normalize();
    })
    .catch(() => {});
  // This site's setting: 'off' | 'suggest' (show a Focus button) | 'auto' (go straight in)
  const siteMode = () => settings.siteModes[location.origin] || 'off';

  const bg = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
  const isVideo = (el) => !!el && el.tagName === 'VIDEO';
  const isMedia = (el) => !!el && /^(VIDEO|IFRAME|EMBED|OBJECT)$/.test(el.tagName);

  // ======================= finding the player =======================
  function allMedia() {
    const out = [];
    const walk = (root) => {
      root.querySelectorAll('video, iframe, embed, object').forEach((el) => {
        if (!el.hasAttribute('data-fp-overlay')) out.push(el);
      });
      root.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) walk(el.shadowRoot);
      });
    };
    walk(document);
    return out;
  }

  function srcOf(el) {
    if (!el) return '';
    if (el.tagName === 'IFRAME') return el.src || (el.hasAttribute('srcdoc') ? 'srcdoc:' + el.srcdoc.length : '');
    if (el.tagName === 'VIDEO') return el.currentSrc || el.src || (el.srcObject ? 'mediastream' : '');
    if (el.tagName === 'OBJECT') return el.data || '';
    return el.src || '';
  }

  function hostOf(src) {
    try {
      return new URL(src, location.href).hostname;
    } catch (_) {
      return '';
    }
  }

  const isAdSize = (w, h) => AD_SIZES.some(([aw, ah]) => Math.abs(w - aw) <= 4 && Math.abs(h - ah) <= 4);

  function rate(el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const w = r.width;
    const h = r.height;
    const info = { el, tag: el.tagName, w: Math.round(w), h: Math.round(h), score: 0, reasons: [], ad: false, ok: false, srcHost: '' };
    const hidden = cs.display === 'none' || parseFloat(cs.opacity || '1') <= 0.05 || (!state.visualsOn && cs.visibility === 'hidden');
    if (hidden) { info.reasons.push('hidden'); return info; }
    if (w < MIN_W || h < MIN_H) { info.reasons.push('too-small'); return info; }

    let s = w * h;
    const ratio = w / h;
    const share = (w * h) / Math.max(1, innerWidth * innerHeight);
    if (isAdSize(w, h)) { s *= 0.05; info.ad = true; info.reasons.push('ad-size'); }
    if (ratio >= 1.5 && ratio <= 1.95) { s *= 1.6; info.reasons.push('tv-shape'); }
    else if (ratio < 1.1 || ratio > 2.6) { s *= 0.4; info.reasons.push('odd-shape'); }
    if (share < 0.1) { s *= 0.5; info.reasons.push('small-share'); }

    const src = srcOf(el).toLowerCase();
    const names = `${el.id} ${typeof el.className === 'string' ? el.className : ''} ${el.getAttribute('name') || ''} ${el.getAttribute('title') || ''}`.toLowerCase();
    if (AD_WORDS.test(src) || AD_WORDS.test(names)) { s *= 0.05; info.ad = true; info.reasons.push('ad-words'); }
    if (PLAYER_WORDS.test(src) || PLAYER_WORDS.test(names)) { s *= 1.3; info.reasons.push('player-words'); }

    if (el.tagName === 'IFRAME') {
      const allow = (el.getAttribute('allow') || '').toLowerCase();
      if (el.hasAttribute('allowfullscreen') || el.hasAttribute('webkitallowfullscreen') || el.hasAttribute('mozallowfullscreen') || allow.includes('fullscreen')) {
        s *= 1.5;
        info.reasons.push('fullscreen-ok');
      }
      if (allow.includes('autoplay') || allow.includes('encrypted-media')) s *= 1.15;
    } else if (el.tagName === 'VIDEO') {
      s *= 1.5;
      if (!el.paused) { s *= 1.5; info.reasons.push('playing'); }
      if (el.loop && el.muted && share < 0.25) { s *= 0.3; info.reasons.push('looping-preview'); }
    }
    info.score = s;
    info.ok = !info.ad;
    info.srcHost = hostOf(src);
    return info;
  }

  function candidates() {
    return allMedia()
      .map(rate)
      .filter((i) => !i.reasons.includes('hidden') && !i.reasons.includes('too-small'))
      .sort((a, b) => b.score - a.score);
  }

  // ---------- remembered pick (per site) ----------
  function signature(el) {
    const src = srcOf(el);
    let path0 = '';
    try {
      path0 = new URL(src, location.href).pathname.split('/').filter(Boolean)[0] || '';
    } catch (_) {}
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName,
      id: el.id || '',
      cls: typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [],
      srcHost: hostOf(src),
      path0,
      ratio: r.height ? +(r.width / r.height).toFixed(2) : 0,
    };
  }

  function matchRemembered(list) {
    const sig = settings.picks && settings.picks[location.hostname];
    if (!sig) return null;
    let best = null;
    let bestPts = 0;
    for (const i of list) {
      if (i.tag !== sig.tag) continue;
      const s = signature(i.el);
      let pts = 0;
      if (sig.id && s.id === sig.id) pts += 5;
      if (sig.srcHost && s.srcHost === sig.srcHost) pts += 3;
      if (sig.path0 && s.path0 === sig.path0) pts += 2;
      pts += s.cls.filter((c) => (sig.cls || []).includes(c)).length;
      if (sig.ratio && s.ratio && Math.abs(s.ratio - sig.ratio) / sig.ratio < 0.15) pts += 1;
      if (pts > bestPts) { bestPts = pts; best = i.el; }
    }
    return bestPts >= 3 ? best : null;
  }

  function rememberPick(el) {
    const picks = { ...(settings.picks || {}) };
    picks[location.hostname] = signature(el);
    settings.picks = picks;
    chrome.storage.local.set({ picks }).catch(() => {});
  }

  function chooseTarget() {
    const list = candidates();
    state.lastList = list;
    const remembered = matchRemembered(list);
    if (remembered) return { el: remembered, list, why: 'remembered' };
    const good = list.filter((i) => i.ok);
    return good.length ? { el: good[0].el, list, why: 'best' } : { el: null, list, why: '' };
  }

  // Tap-to-pick: what media element is under this point?
  function mediaAt(x, y) {
    const f = state.overlay;
    if (f) f.style.setProperty('pointer-events', 'none', 'important');
    try {
      const seen = new Set();
      const scan = (root) => {
        for (const el of root.elementsFromPoint(x, y)) {
          if (seen.has(el)) continue;
          seen.add(el);
          if (el.hasAttribute && el.hasAttribute('data-fp-overlay')) continue;
          if (isMedia(el)) return el;
          if (el.shadowRoot) {
            const inner = scan(el.shadowRoot);
            if (inner) return inner;
          }
        }
        return null;
      };
      let el = scan(document);
      if (!el) {
        let bestA = Infinity;
        for (const m of allMedia()) {
          const r = m.getBoundingClientRect();
          const a = r.width * r.height;
          if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && a >= 100 * 60 && a < bestA) {
            bestA = a;
            el = m;
          }
        }
      }
      return el;
    } finally {
      if (f) f.style.setProperty('pointer-events', 'auto', 'important');
    }
  }

  // ======================= marking the chosen player =======================
  function clearMarks() {
    for (const el of state.marked) {
      el.removeAttribute('data-fp-target');
      el.removeAttribute('data-fp-ancestor');
    }
    state.marked = [];
    for (const s of state.shadowStyles) s.remove();
    state.shadowStyles = [];
    detachVideoListeners();
  }

  function addShadowStyle(root) {
    if (state.shadowStyles.some((s) => s.parentNode === root)) return;
    const s = document.createElement('style');
    s.textContent = fill(SHADOW_CSS);
    root.appendChild(s);
    state.shadowStyles.push(s);
  }

  function setTarget(el) {
    clearMarks();
    state.target = el;
    el.setAttribute('data-fp-target', '');
    state.marked.push(el);
    let n = el;
    for (;;) {
      const root = n.getRootNode();
      if (root instanceof ShadowRoot) addShadowStyle(root);
      let p = n.parentElement;
      if (!p && root instanceof ShadowRoot) p = root.host;
      if (!p || p === document.documentElement) break;
      p.setAttribute('data-fp-ancestor', '');
      state.marked.push(p);
      n = p;
    }
    if (isVideo(el)) attachVideoListeners(el);
    if (el.hasAttribute('data-fp-hushed')) {
      el.removeAttribute('data-fp-hushed');
      try { el.muted = false; } catch (_) {}
    }
    state.agents.clear();
    state.mainFrame = null;
    resetFreezeClock(GRACE_MS);
  }

  function attachVideoListeners(v) {
    const h = () => pushState();
    ['play', 'pause', 'volumechange'].forEach((ev) => v.addEventListener(ev, h));
    state.videoListeners = { v, h };
  }

  function detachVideoListeners() {
    const l = state.videoListeners;
    if (!l) return;
    ['play', 'pause', 'volumechange'].forEach((ev) => l.v.removeEventListener(ev, l.h));
    state.videoListeners = null;
  }

  function visuals(on) {
    state.visualsOn = on;
    if (on) {
      if (!document.getElementById(STYLE_ID)) {
        const s = document.createElement('style');
        s.id = STYLE_ID;
        s.textContent = fill(PAGE_CSS);
        (document.head || document.documentElement).appendChild(s);
      }
      document.documentElement.setAttribute('data-fp-on', '');
    } else {
      document.documentElement.removeAttribute('data-fp-on');
      clearMarks();
    }
  }

  // ======================= Deep mode agents (inside embedded players) =======================
  function mainAgent() {
    const now = Date.now();
    let best = null;
    for (const a of state.agents.values()) {
      if (now - a.at > AGENT_FRESH_MS || !a.hasVideo || a.w * a.h < MIN_W * MIN_H) continue;
      if (!best || a.w * a.h > best.w * best.h) best = a;
    }
    return best;
  }

  function playbackView() {
    const t = state.target;
    if (isVideo(t)) {
      let lag = null;
      try {
        const s = t.seekable;
        if (s && s.length) {
          const e = s.end(s.length - 1);
          if (isFinite(e)) lag = e - t.currentTime;
        }
      } catch (_) {}
      return { paused: t.paused || t.ended, t: t.currentTime, lag, via: 'video' };
    }
    const a = mainAgent();
    if (a) return { paused: a.paused || a.ended, t: a.t, lag: a.lag, via: 'deep' };
    return null;
  }

  function control(cmd) {
    const v = isVideo(state.target) ? state.target : null;
    if (v) {
      if (cmd === 'play') {
        if (v.paused) { wd.userPaused = false; v.play()?.catch?.(() => {}); }
        else { wd.userPaused = true; v.pause(); }
      } else if (cmd === 'mute') v.muted = !v.muted;
      else if (cmd === 'volup') { v.muted = false; v.volume = Math.min(1, Math.round((v.volume + 0.1) * 10) / 10); }
      else if (cmd === 'voldown') v.volume = Math.max(0, Math.round((v.volume - 0.1) * 10) / 10);
      else if (cmd === 'jumplive') jumpToLive(v);
      return;
    }
    const a = mainAgent();
    if (!a) return;
    if (cmd === 'play') wd.userPaused = !a.paused;
    bg({ fp: 'agent-cmd', frameId: a.frameId, cmd });
  }

  chrome.runtime.onMessage.addListener((m) => {
    if (!m) return;
    if (m.fp === 'blocked-tab') {
      if (state.overlay && state.mode === 'focus') pushState({ toast: 'Blocked a pop-up tab' });
      else pageToast('Focus Player blocked a pop-up tab');
      return;
    }
    if (m.fp !== 'agent-report' || state.mode !== 'focus') return;
    state.agents.set(m.frameId, { ...m, at: Date.now() });
    const a = mainAgent();
    const fid = a ? a.frameId : null;
    if (fid !== state.mainFrame) {
      state.mainFrame = fid;
      bg({ fp: 'main-frame', frameId: fid });
    }
    pushState();
  });

  // ======================= re-finding the player if the site swaps it =======================
  function startObserver() {
    stopObserver();
    state.observer = new MutationObserver(() => {
      if (state.target && state.target.isConnected) return;
      clearTimeout(state.observerTimer);
      state.observerTimer = setTimeout(retarget, 300);
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function stopObserver() {
    state.observer?.disconnect();
    state.observer = null;
    clearTimeout(state.observerTimer);
  }

  function retarget() {
    if (state.mode !== 'focus' || (state.target && state.target.isConnected)) return true;
    const c = chooseTarget(); // visualsOn=true here, so our own hiding is ignored when rating
    if (!c.el) return false;
    state.candidates = c.list.filter((i) => i.ok).map((i) => i.el);
    state.idx = Math.max(0, state.candidates.indexOf(c.el));
    setTarget(c.el);
    bg({ fp: 'agents-refresh' });
    pushState({ toast: 'Found the player again' });
    return true;
  }

  // ======================= auto-fix =======================
  function resetFreezeClock(grace) {
    wd.stillSince = 0;
    wd.lastT = null;
    wd.stage = 0;
    wd.hinted = false;
    wd.graceUntil = Date.now() + (grace || 0);
    bg({ fp: 'frame-reset' });
  }

  function startWatchdog() {
    stopWatchdog();
    wd.fixes = [];
    wd.userPaused = false;
    resetFreezeClock(GRACE_MS);
    wd.timer = setInterval(tick, TICK_MS);
  }

  function stopWatchdog() {
    clearInterval(wd.timer);
    wd.timer = null;
  }

  async function tick() {
    if (state.mode !== 'focus' || wd.busy) return;
    const now = Date.now();

    if (!state.target || !state.target.isConnected) {
      if (!retarget()) {
        if (!state.lostSince) state.lostSince = now;
        else if (now - state.lostSince > 10000) showWait('loading');
      }
      return;
    }
    state.lostSince = 0;

    if (settings.deep && !isVideo(state.target) && !mainAgent() && now - state.agentAsk > 10000) {
      state.agentAsk = now;
      bg({ fp: 'agents-refresh' });
    }

    if (!settings.autofix || !state.locked || document.visibilityState !== 'visible' || now < wd.graceUntil) {
      wd.stillSince = 0;
      wd.lastT = null;
      return;
    }

    let moving = null;
    const pv = playbackView();
    if (pv) {
      wd.lastVia = pv.via;
      if (pv.paused && wd.userPaused) { wd.stillSince = 0; wd.lastT = null; return; }
      if (pv.paused && pv.t < 0.5) {
        if (!wd.hinted) {
          wd.hinted = true;
          pushState({ toast: 'Video hasn’t started. Hold Unlock, press the player’s play button, then Lock.' });
        }
        return;
      }
      if (!pv.paused && pv.lag != null && pv.lag > LIVE_LAG_S && now - wd.lastLiveJump > 30000) {
        wd.lastLiveJump = now;
        control('jumplive');
        pushState({ toast: 'Caught up to live' });
      }
      moving = pv.paused ? false : wd.lastT === null ? null : pv.t !== wd.lastT;
      wd.lastT = pv.t;
    } else {
      wd.lastVia = 'snapshot';
      wd.busy = true;
      try {
        const r = await bg({ fp: 'frame-check' });
        if (r && typeof r.diff === 'number') {
          wd.lastDiff = r.diff;
          moving = r.diff > 0.35;
        }
      } finally {
        wd.busy = false;
      }
    }

    if (moving === null) return;
    if (moving) { wd.stillSince = 0; wd.stage = 0; return; }
    if (!wd.stillSince) wd.stillSince = now;
    if (now - wd.stillSince >= (wd.stage === 1 ? FROZEN_MS / 2 : FROZEN_MS)) {
      wd.stillSince = 0;
      recover();
    }
  }

  function recover() {
    const now = Date.now();
    wd.fixes = wd.fixes.filter((t) => now - t < FIX_WINDOW_MS);
    if (wd.fixes.length >= MAX_FIXES) {
      wd.graceUntil = now + 60000;
      pushState({ toast: 'This feed keeps freezing and may be down. Unlock → Tools → Change source.' });
      return;
    }
    if (playbackView() && wd.stage === 0) {
      wd.stage = 1;
      wd.graceUntil = now + 6000;
      control('jumplive');
      pushState({ toast: 'Picture froze. Jumping back to live…' });
      return;
    }
    wd.fixes.push(now);
    reloadPlayer('auto');
  }

  function jumpToLive(v) {
    try {
      const s = v.seekable;
      if (s && s.length) {
        const end = s.end(s.length - 1);
        if (isFinite(end) && end - v.currentTime > 3) v.currentTime = end - 2;
      }
    } catch (_) {}
    const p = v.play();
    if (p && p.catch) p.catch(() => {});
  }

  function reloadPlayer(why) {
    const el = state.target;
    if (!el) return;
    let ok = true;
    if (el.tagName === 'IFRAME') {
      if (el.hasAttribute('srcdoc')) el.srcdoc = el.getAttribute('srcdoc');
      else if (el.src) el.src = el.src; // same URL = fresh load
      else ok = false;
    } else if (el.tagName === 'VIDEO') {
      const src = el.currentSrc || el.src;
      if (src && !src.startsWith('blob:') && !el.srcObject) {
        el.load();
        jumpToLive(el);
      } else {
        jumpToLive(el);
        ok = !el.paused;
      }
    } else {
      const clone = el.cloneNode(true);
      el.replaceWith(clone);
      setTarget(clone);
    }
    state.agents.clear();
    resetFreezeClock(GRACE_MS);
    setTimeout(() => bg({ fp: 'agents-refresh' }), 2500);
    if (!ok) pushState({ toast: 'Couldn’t restart this player. Exit, reload the page, and turn Focus Player back on.' });
    else pushState({ toast: why === 'auto' ? 'Picture froze. Restarting the player…' : 'Restarting the player…' });
  }

  // ======================= overlay (extension iframe: taps never reach the page) =======================
  function ensureOverlay() {
    if (state.overlay && state.overlay.isConnected) return;
    const f = document.createElement('iframe');
    f.src = OVERLAY_URL;
    f.setAttribute('allowtransparency', 'true');
    f.setAttribute('aria-label', 'Focus Player controls');
    f.setAttribute('data-fp-overlay', '');
    state.overlay = f;
    styleOverlay();
    document.documentElement.appendChild(f);
  }

  function removeOverlay() {
    state.overlay?.remove();
    state.overlay = null;
  }

  function uiMode() {
    if (state.mode === 'focus') return state.locked ? 'locked' : state.menuOpen ? 'menu' : 'unlocked';
    return state.mode; // pick | wait | suggest
  }

  function styleOverlay() {
    const f = state.overlay;
    if (!f) return;
    const base = {
      position: 'fixed', border: '0', margin: '0', padding: '0', 'z-index': '2147483647',
      background: 'transparent', 'color-scheme': 'light', display: 'block', visibility: 'visible',
      opacity: '1', 'max-width': 'none', 'max-height': 'none', 'pointer-events': 'auto',
      transform: 'none', right: 'auto', bottom: 'auto', 'box-shadow': 'none',
    };
    const full = { top: '0', left: '0', width: '100vw', height: '100vh', 'border-radius': '0' };
    const boxes = {
      locked: full,
      pick: full,
      unlocked: { top: '12px', left: '12px', width: '360px', height: '64px', 'border-radius': '18px' },
      suggest: { top: 'calc(100vh - 88px)', left: 'calc(100vw - 388px)', width: '368px', height: '68px', 'border-radius': '20px' },
      menu: { top: '12px', left: '12px', width: '360px', height: 'min(560px, calc(100vh - 24px))', 'border-radius': '18px' },
      wait: { top: '12px', left: 'calc(50vw - min(310px, 48vw))', width: 'min(620px, 96vw)', height: '72px', 'border-radius': '20px' },
    };
    const box = boxes[uiMode()] || full;
    for (const [k, v] of Object.entries({ ...base, ...box })) f.style.setProperty(k, v, 'important');
  }

  function waitText() {
    if (state.waitReason === 'sources') return 'Click a source. I’ll lock on when it plays.';
    if (Date.now() - state.waitStart > 60000) return 'Still no video. Start the stream, or tap Pick it.';
    return 'Waiting for the video to start…';
  }

  function pushState(extra) {
    const f = state.overlay;
    if (!f || !f.contentWindow) return;
    const v = isVideo(state.target) ? state.target : null;
    const a = v ? null : mainAgent();
    f.contentWindow.postMessage(
      {
        __fp: 'state',
        ui: uiMode(),
        locked: state.locked,
        hasControls: !!(v || a),
        paused: v ? v.paused : a ? a.paused : null,
        muted: v ? v.muted : a ? a.muted : null,
        multi: state.candidates.length > 1,
        fullscreen: !!document.fullscreenElement,
        autofix: settings.autofix,
        deep: !!settings.deep,
        remembered: !!(settings.picks && settings.picks[location.hostname]),
        silence: settings.silence,
        blockAds: settings.blockAds,
        siteMode: siteMode(),
        suggestLabel: state.suggestEl ? describe(state.suggestEl) : '',
        origin: location.origin,
        host: location.hostname,
        waitReason: state.waitReason,
        waitText: waitText(),
        ...(extra || {}),
      },
      EXT_ORIGIN
    );
  }

  function onMessage(e) {
    if (state.mode === 'off' || !state.overlay || e.source !== state.overlay.contentWindow) return;
    if (e.origin !== EXT_ORIGIN) return;
    const d = e.data;
    if (!d || d.__fp !== true) return;
    switch (d.cmd) {
      case 'ready': pushState(); break;
      case 'play': case 'mute': case 'volup': case 'voldown': control(d.cmd); break;
      case 'fullscreen': toggleFullscreen(); break;
      case 'reload': if (state.mode === 'focus') reloadPlayer('manual'); break;
      case 'next': next(); break;
      case 'unlock': setLocked(false); break;
      case 'lock': setLocked(true); break;
      case 'menu': state.menuOpen = !!d.open; styleOverlay(); pushState(); break;
      case 'sources': showWait('sources'); break;
      case 'pick': showPick(); break;
      case 'done': {
        const c = chooseTarget();
        if (c.el) enterFocus(c.el, c.why);
        else pushState({ toast: 'No video found yet' });
        break;
      }
      case 'hover': {
        const el = mediaAt(d.x, d.y);
        if (!el) { pushState({ hover: null }); break; }
        const r = el.getBoundingClientRect();
        const i = rate(el);
        const label = `${el.tagName === 'VIDEO' ? 'Video' : 'Player'} ${Math.round(r.width)}×${Math.round(r.height)}${i.ad ? ' · looks like an ad' : ''}`;
        pushState({ hover: { x: r.left, y: r.top, w: r.width, h: r.height, label, ad: i.ad } });
        break;
      }
      case 'pickAt': {
        const el = mediaAt(d.x, d.y);
        if (!el) { pushState({ toast: 'No video there. Tap right on the video.' }); break; }
        state.lastList = candidates();
        rememberPick(el);
        enterFocus(el, 'picked');
        break;
      }
      case 'pickCancel': {
        const t = state.prevTarget;
        if (t && t.isConnected) enterFocus(t, 'back');
        else exitAll(false);
        break;
      }
      case 'autofix':
        settings.autofix = !settings.autofix;
        chrome.storage.local.set({ autofix: settings.autofix }).catch(() => {});
        resetFreezeClock(0);
        pushState({ toast: settings.autofix ? 'Auto-fix on' : 'Auto-fix off' });
        break;
      case 'forget': {
        const picks = { ...(settings.picks || {}) };
        delete picks[location.hostname];
        settings.picks = picks;
        chrome.storage.local.set({ picks }).catch(() => {});
        pushState({ toast: 'Forgot the remembered video for this site' });
        break;
      }
      case 'diag': pushState({ diag: diagnostics() }); break;
      case 'exit': exitAll(false); break;
      case 'dismiss': exitAll(true); break;
      case 'focusNow': {
        const c = chooseTarget();
        if (c.el) enterFocus(c.el, c.why);
        break;
      }
      case 'silence':
        settings.silence = !settings.silence;
        chrome.storage.local.set({ silence: settings.silence }).catch(() => {});
        pushState({ toast: settings.silence ? 'Other sounds silenced' : 'Other sounds allowed' });
        break;
    }
  }

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    for (const k of Object.keys(ch)) settings[k] = ch[k].newValue;
    normalize();
    if ('silence' in ch && state.mode === 'focus') bg({ fp: 'status', mode: state.mode });
    if ('deep' in ch && state.mode === 'focus') {
      state.agentAsk = Date.now();
      bg({ fp: 'agents-refresh' });
      bg({ fp: 'status', mode: state.mode }); // re-apply pop-up guard to all frames
    }
    pushState();
  });

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else
      document.documentElement.requestFullscreen().catch(() => {
        pushState({ toast: 'Full screen was blocked here. Try F11 (Windows) or Ctrl+Cmd+F (Mac).' });
      });
  }

  function setLocked(v) {
    state.locked = !!v;
    state.menuOpen = false;
    styleOverlay();
    resetFreezeClock(state.locked ? GRACE_MS : 0);
    pushState({ toast: state.locked ? 'Kid lock on' : '' });
  }

  function next() {
    state.candidates = state.candidates.filter((el) => el.isConnected);
    if (state.candidates.length < 2) {
      pushState({ toast: 'Only one video on this page' });
      return;
    }
    state.idx = (state.idx + 1) % state.candidates.length;
    setTarget(state.candidates[state.idx]);
    bg({ fp: 'agents-refresh' });
    pushState({ toast: `Video ${state.idx + 1} of ${state.candidates.length}` });
  }

  function onBeforeUnload(e) {
    e.preventDefault();
    e.returnValue = '';
    return '';
  }

  // ======================= modes =======================
  function status() {
    bg({ fp: 'status', mode: state.mode });
  }

  function leaveFocus() {
    stopWatchdog();
    stopObserver();
    visuals(false);
    window.removeEventListener('beforeunload', onBeforeUnload, true);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  function enterFocus(el, why) {
    stopWaitPoll();
    state.mode = 'focus';
    state.locked = true;
    state.menuOpen = false;
    const good = (state.lastList || []).filter((i) => i.ok || i.el === el).map((i) => i.el);
    if (!good.includes(el)) good.unshift(el);
    state.candidates = good;
    state.idx = good.indexOf(el);
    state.prevTarget = el;
    visuals(true);
    setTarget(el);
    ensureOverlay();
    styleOverlay();
    window.addEventListener('beforeunload', onBeforeUnload, true);
    startObserver();
    startWatchdog();
    status();
    const toasts = {
      picked: 'Got it. I’ll use this video on this site from now on.',
      switched: 'Locked on to the new source',
      remembered: 'Using the video you picked last time',
    };
    pushState(toasts[why] ? { toast: toasts[why] } : null);
  }

  function showWait(reason) {
    leaveFocus();
    state.mode = 'wait';
    state.waitReason = reason;
    state.menuOpen = false;
    if (reason === 'sources') {
      state.baseline = new Map(allMedia().map((el) => [el, srcOf(el)]));
    }
    ensureOverlay();
    styleOverlay();
    startWaitPoll();
    status();
    pushState();
  }

  function showPick() {
    leaveFocus();
    stopWaitPoll();
    state.mode = 'pick';
    ensureOverlay();
    styleOverlay();
    status();
    pushState();
  }

  // Quietly watch the page for a player. kind 'auto' = go straight into focus; 'suggest' = show the Focus button.
  function arm(kind) {
    state.mode = 'armed';
    state.armKind = kind;
    state.waitReason = 'auto';
    state.suggestEl = null;
    removeOverlay();
    startWaitPoll();
    status();
  }

  function showSuggest(el) {
    state.mode = 'suggest';
    state.suggestEl = el;
    ensureOverlay();
    styleOverlay();
    status();
    pushState();
  }

  function describe(el) {
    const r = el.getBoundingClientRect();
    return `${el.tagName === 'VIDEO' ? 'Video' : 'Player'} ${Math.round(r.width)}\u00d7${Math.round(r.height)}`;
  }

  // hard = really off for this page. Otherwise, on sites set to Button/Auto,
  // fall back to the Focus button so getting back in is one tap.
  function exitAll(hard) {
    leaveFocus();
    stopWaitPoll();
    removeOverlay();
    state.target = null;
    state.candidates = [];
    state.agents.clear();
    state.suggestEl = null;
    if (!hard && siteMode() !== 'off') {
      arm('suggest');
      return;
    }
    state.mode = 'off';
    status();
  }

  function startWaitPoll() {
    stopWaitPoll();
    state.waitStart = Date.now();
    state.pending = null;
    state.waitTimer = setInterval(waitTick, 1000);
  }

  function stopWaitPoll() {
    clearInterval(state.waitTimer);
    state.waitTimer = null;
  }

  function waitTick() {
    const now = Date.now();
    if ((state.mode === 'armed' || state.mode === 'suggest') && document.visibilityState !== 'visible') return;
    const c = chooseTarget();
    if (state.mode === 'suggest') {
      if (!c.el) arm('suggest');
      else if (c.el !== state.suggestEl) { state.suggestEl = c.el; pushState(); }
      return;
    }
    let el = null;
    let why = c.why;
    if (state.mode === 'wait' && state.waitReason === 'sources') {
      const ch = c.list.find((i) => i.ok && (!state.baseline.has(i.el) || state.baseline.get(i.el) !== srcOf(i.el)));
      el = ch ? ch.el : null;
      why = 'switched';
    } else {
      el = c.el;
    }
    if (state.mode === 'wait' && (now - state.waitStart) % 15000 < 1000) pushState();
    if (!el) { state.pending = null; return; }
    if (!state.pending || state.pending.el !== el) {
      state.pending = { el, since: now };
      return;
    }
    if (now - state.pending.since >= 1200) {
      if (state.mode === 'armed' && state.armKind === 'suggest') showSuggest(el);
      else enterFocus(el, why);
    }
  }

  async function start(trigger) {
    await settingsReady;
    if (state.mode !== 'off' && state.mode !== 'armed' && state.mode !== 'suggest') return;
    if (trigger === 'page-load') {
      const m = siteMode();
      if (m === 'off') return;
      arm(m === 'auto' ? 'auto' : 'suggest');
      return;
    }
    const c = chooseTarget();
    if (c.el) enterFocus(c.el, c.why);
    else showWait('loading');
  }

  // ======================= diagnostics =======================
  function diagnostics() {
    const now = Date.now();
    const L = [];
    const chrome_ = (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || '?';
    L.push(`Focus Player ${VERSION} diagnostics`);
    L.push(`Site: ${location.hostname}   Mode: ${state.mode}${state.mode === 'focus' ? (state.locked ? ' (locked)' : ' (unlocked)') : ''}`);
    L.push(`Window: ${innerWidth}x${innerHeight}   Chrome ${chrome_}`);
    L.push(`Settings: this site ${siteMode()} | auto-fix ${settings.autofix ? 'on' : 'off'} | silence ${settings.silence ? 'on' : 'off'} | block ads ${settings.blockAds ? 'on' : 'off'} | deep ${settings.deep ? 'on' : 'off'} | remembered pick ${settings.picks && settings.picks[location.hostname] ? 'yes' : 'no'}`);
    L.push('Players found when chosen (best first):');
    (state.lastList || []).slice(0, 8).forEach((i, n) => {
      const mark = i.el === state.target ? '  <- showing' : '';
      L.push(`  ${n + 1}. ${i.tag} ${i.w}x${i.h} score ${Math.round(i.score)} host ${i.srcHost || '-'} [${i.reasons.join(', ') || '-'}]${mark}`);
    });
    if (!(state.lastList || []).length) L.push('  (none)');
    const ags = [...state.agents.values()].filter((a) => now - a.at < AGENT_FRESH_MS);
    L.push(`Deep-mode frames reporting: ${ags.length}`);
    ags.forEach((a) =>
      L.push(`  frame ${a.frameId}: ${a.hasVideo ? `video ${a.w}x${a.h} ${a.paused ? 'paused' : 'playing'} t=${(a.t || 0).toFixed(1)} behind-live ${a.lag == null ? '-' : a.lag.toFixed(1) + 's'} ready=${a.rs}` : 'no video'}`)
    );
    L.push(`Auto-fix: restarts in last 3 min ${wd.fixes.filter((x) => now - x < FIX_WINDOW_MS).length} | last check via ${wd.lastVia || '-'} | last snapshot change ${wd.lastDiff == null ? '-' : wd.lastDiff.toFixed(2)}`);
    return L.join('\n');
  }

  function pageToast(text) {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      div{position:fixed;left:50%;top:24px;transform:translateX(-50%);z-index:2147483647;
      background:#111;color:#fff;font:600 15px/1.3 system-ui,sans-serif;padding:14px 18px;
      border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.4);max-width:80vw;text-align:center}</style><div></div>`;
    root.querySelector('div').textContent = text;
    document.documentElement.appendChild(host);
    setTimeout(() => host.remove(), 3000);
  }

  window.addEventListener('message', onMessage, true);
  document.addEventListener('fullscreenchange', () => pushState(), true);

  // Let real new-tab clicks through the pop-up tab blocker: a trusted click on a
  // normal-sized link that opens a new tab. Page-sized invisible links (a common
  // pop-under trick) don't count.
  function onTrustedClick(e) {
    if (!e.isTrusted || state.mode === 'off' || state.mode === 'focus') return;
    const a = e.composedPath().find((n) => n && n.tagName === 'A' && n.href);
    if (!a) return;
    const newTab = a.target === '_blank' || e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1;
    if (!newTab) return;
    const r = a.getBoundingClientRect();
    if (r.width * r.height > 0.4 * innerWidth * innerHeight) return;
    bg({ fp: 'allow-next-tab' });
  }
  document.addEventListener('click', onTrustedClick, true);
  document.addEventListener('auxclick', onTrustedClick, true);
  document.addEventListener(
    'contextmenu',
    (e) => {
      if (!e.isTrusted || state.mode === 'off' || state.mode === 'focus') return;
      if (e.composedPath().some((n) => n && n.tagName === 'A' && n.href)) bg({ fp: 'allow-next-tab', ms: 15000 });
    },
    true
  );

  // Summary for the toolbar popup.
  function info() {
    let found = null;
    if (state.mode === 'focus' && state.target) found = { label: describe(state.target), ad: false };
    else {
      const c = chooseTarget();
      if (c.el) found = { label: describe(c.el), ad: false };
      else if (c.list.length) found = { label: describe(c.list[0].el), ad: true };
    }
    return {
      mode: state.mode,
      locked: state.locked,
      found,
      siteMode: siteMode(),
      origin: location.origin,
      host: location.hostname,
    };
  }

  async function handle(action) {
    await settingsReady;
    switch (action) {
      case 'toggle':
        if (state.mode === 'focus' || state.mode === 'wait' || state.mode === 'pick') exitAll(false);
        else start('user');
        break;
      case 'focus':
        if (state.mode !== 'focus') start('user');
        break;
      case 'exit':
        if (state.mode !== 'off') exitAll(false);
        break;
      case 'page-load':
        start('page-load');
        break;
      case 'site-changed':
        settings.siteModes = (await chrome.storage.local.get('siteModes')).siteModes || {};
        if (state.mode === 'off' || state.mode === 'armed' || state.mode === 'suggest') {
          if (siteMode() === 'off') { if (state.mode !== 'off') exitAll(true); }
          else arm(siteMode() === 'auto' ? 'auto' : 'suggest');
        }
        break;
      case 'pick':
        showPick();
        break;
      case 'sources':
        showWait('sources');
        break;
      case 'toggle-lock':
        if (state.mode === 'focus') setLocked(!state.locked);
        break;
      case 'next':
        if (state.mode === 'focus') next();
        break;
      case 'reload':
        if (state.mode === 'focus') reloadPlayer('manual');
        break;
    }
    return info();
  }

  window.__focusPlayer = { handle, info: async () => { await settingsReady; return info(); } };
})();
