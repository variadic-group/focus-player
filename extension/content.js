// Focus Player — content script (isolated world, top frame only).
// Theater mode for any web video: finds the main player, fills the window with it,
// and adds speed, picture-in-picture, live catch-up and stall recovery. Site-agnostic.
(() => {
  if (window.__focusPlayer) return;

  const VERSION = chrome.runtime.getManifest().version;
  const EXT_ORIGIN = new URL(chrome.runtime.getURL('')).origin;
  const UI_URL = chrome.runtime.getURL('ui.html');
  const STYLE_ID = '__fp-style';
  const MIN_W = 200;
  const MIN_H = 120;

  const TICK_MS = 3000; // health check interval in theater mode
  const STALL_MS = 12000; // playing but the clock isn't moving this long = stalled
  const FROZEN_HINT_MS = 15000; // picture unchanged this long (when we can't see inside the player) = offer Reload
  const GRACE_MS = 10000; // time a (re)started player gets before we judge it
  const MAX_FIXES = 3;
  const FIX_WINDOW_MS = 180000;
  const AGENT_FRESH_MS = 7000;
  const LIVE_BEHIND_S = 15; // show "Go live" when further behind than this

  // Common ad slot sizes (IAB). A frame this size is almost never the main video.
  const AD_SIZES = [
    [300, 250], [336, 280], [728, 90], [970, 90], [970, 250], [160, 600], [300, 600],
    [320, 50], [320, 100], [468, 60], [250, 250], [200, 200], [120, 600], [300, 50], [300, 100],
  ];
  const AD_WORDS =
    /(^|[\/._\-?=&#\s])(ads?|adv|advert\w*|banner\w*|sponsor\w*|promo\w*|popunder|doubleclick|googlesyndication|adserver|adservice|taboola|outbrain|prebid)([\/._\-?=&#\s]|$)/;
  const PLAYER_WORDS = /(embed|player|stream|live|watch|video|hls|jwplayer|clappr|videojs|plyr)/;
  const CHAT_WORDS = /(chat|comment|disqus|chatango|tlk\.io|shoutbox|minnit|cbox|tawk|crisp|intercom|livechat|discord)/;

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
  const PAGE_CSS = `
html[data-fp-on] { background:#000 !important; overflow:hidden !important; }
html[data-fp-on] body { background:transparent !important; overflow:hidden !important; }
html[data-fp-on] body * { visibility:hidden !important; }
html[data-fp-on] [data-fp-target], html[data-fp-on] [data-fp-target] * { visibility:visible !important; }
html[data-fp-on] [data-fp-target] { ${TARGET_RULES} }
html[data-fp-on] [data-fp-target][data-fp-fill] { object-fit:cover !important; }
html[data-fp-on] [data-fp-ancestor] { ${ANCESTOR_RULES} }`;
  const SHADOW_CSS = `
[data-fp-target], [data-fp-target] * { visibility:visible !important; }
[data-fp-target] { ${TARGET_RULES} }
[data-fp-target][data-fp-fill] { object-fit:cover !important; }
[data-fp-ancestor] { ${ANCESTOR_RULES} }`;

  // mode: off | armed (watching for a video on a Button/Always site) | suggest (Theater button showing)
  //       | wait (you asked, no video yet) | pick (tap the video you want) | theater
  const state = {
    mode: 'off',
    armKind: 'suggest',
    menuOpen: false,
    visualsOn: false,
    target: null,
    prevTarget: null,
    marked: [],
    shadowStyles: [],
    candidates: [],
    idx: 0,
    lastList: [],
    frame: null,
    frameReady: false,
    videoListeners: null,
    observer: null,
    observerTimer: null,
    lostSince: 0,
    waitTimer: null,
    waitStart: 0,
    pending: null,
    agents: new Map(),
    mainFrame: null,
    agentAsk: 0,
    suggestEl: null,
    speed: 1,
    lag: null,
    fill: false,
    frozen: false,
    timers: [],
  };

  const wd = { timer: null, stillSince: 0, lastT: null, stage: 0, fixes: [], graceUntil: 0, busy: false, lastDiff: null, via: '' };

  let settings = { deep: false, recover: true, silence: true, blockAds: true, siteModes: {}, picks: {}, speeds: {} };
  const normalize = () => {
    settings.recover = settings.recover !== false;
    settings.silence = settings.silence !== false;
    settings.blockAds = settings.blockAds !== false;
    settings.siteModes = settings.siteModes || {};
    settings.picks = settings.picks || {};
    settings.speeds = settings.speeds || {};
  };
  const settingsReady = chrome.storage.local
    .get(['deep', 'recover', 'silence', 'blockAds', 'siteModes', 'picks', 'speeds'])
    .then((s) => {
      settings = { ...settings, ...s };
      normalize();
    })
    .catch(() => {});
  const siteMode = () => settings.siteModes[location.origin] || 'off'; // off | suggest | auto

  const bg = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
  const isVideo = (el) => !!el && el.tagName === 'VIDEO';
  const isMedia = (el) => !!el && /^(VIDEO|IFRAME|EMBED|OBJECT)$/.test(el.tagName);
  const fmtRate = (r) => (Math.round(r * 100) / 100).toString().replace(/\.0+$/, '');
  const later = (fn, ms) => state.timers.push(setTimeout(fn, ms));

  // ======================= finding the player =======================
  function allMedia() {
    const out = [];
    const walk = (root) => {
      root.querySelectorAll('video, iframe, embed, object').forEach((el) => {
        if (!el.hasAttribute('data-fp-ui')) out.push(el);
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
    const info = { el, tag: el.tagName, w: Math.round(w), h: Math.round(h), score: 0, reasons: [], ok: false, srcHost: '' };
    const hidden = cs.display === 'none' || parseFloat(cs.opacity || '1') <= 0.05 || (!state.visualsOn && cs.visibility === 'hidden');
    if (hidden) { info.reasons.push('hidden'); return info; }
    if (w < MIN_W || h < MIN_H) { info.reasons.push('too-small'); return info; }

    let s = w * h;
    let bad = false;
    const ratio = w / h;
    const share = (w * h) / Math.max(1, innerWidth * innerHeight);
    if (isAdSize(w, h)) { s *= 0.05; bad = true; info.reasons.push('ad-size'); }
    if (ratio >= 1.5 && ratio <= 1.95) { s *= 1.6; info.reasons.push('tv-shape'); }
    else if (ratio < 1.1 || ratio > 2.6) { s *= 0.4; info.reasons.push('odd-shape'); }
    if (share < 0.1) { s *= 0.5; info.reasons.push('small-share'); }

    const src = srcOf(el).toLowerCase();
    const names = `${el.id} ${typeof el.className === 'string' ? el.className : ''} ${el.getAttribute('name') || ''} ${el.getAttribute('title') || ''}`.toLowerCase();
    if (AD_WORDS.test(src) || AD_WORDS.test(names)) { s *= 0.05; bad = true; info.reasons.push('ad-words'); }
    if (CHAT_WORDS.test(src) || CHAT_WORDS.test(names)) { s *= 0.05; bad = true; info.reasons.push('chat-like'); }
    if (el.tagName !== 'VIDEO' && ratio < 0.9) { bad = true; info.reasons.push('portrait'); }
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
    info.ok = !bad;
    info.srcHost = hostOf(src);
    return info;
  }

  function candidates() {
    return allMedia()
      .map(rate)
      .filter((i) => !i.reasons.includes('hidden') && !i.reasons.includes('too-small'))
      .sort((a, b) => b.score - a.score);
  }

  // ---------- "Pick a different video" is remembered per site ----------
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
    const sig = settings.picks[location.hostname];
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
    settings.picks = { ...settings.picks, [location.hostname]: signature(el) };
    chrome.storage.local.set({ picks: settings.picks }).catch(() => {});
  }

  function chooseTarget() {
    const list = candidates();
    state.lastList = list;
    const remembered = matchRemembered(list);
    if (remembered) return { el: remembered, list, why: 'remembered' };
    const good = list.filter((i) => i.ok);
    return good.length ? { el: good[0].el, list, why: 'best' } : { el: null, list, why: '' };
  }

  // What player is under this point? (Pick mode)
  function mediaAt(x, y) {
    const f = state.frame;
    if (f) f.style.setProperty('pointer-events', 'none', 'important');
    try {
      const seen = new Set();
      const scan = (root) => {
        for (const el of root.elementsFromPoint(x, y)) {
          if (seen.has(el)) continue;
          seen.add(el);
          if (el.hasAttribute && el.hasAttribute('data-fp-ui')) continue;
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

  // ======================= filling the window =======================
  function clearMarks() {
    for (const el of state.marked) {
      el.removeAttribute('data-fp-target');
      el.removeAttribute('data-fp-ancestor');
      el.removeAttribute('data-fp-fill');
    }
    state.marked = [];
    for (const s of state.shadowStyles) s.remove();
    state.shadowStyles = [];
    detachVideoListeners();
  }

  function addShadowStyle(root) {
    if (state.shadowStyles.some((s) => s.parentNode === root)) return;
    const s = document.createElement('style');
    s.textContent = SHADOW_CSS;
    root.appendChild(s);
    state.shadowStyles.push(s);
  }

  function setTarget(el) {
    clearMarks();
    state.target = el;
    el.setAttribute('data-fp-target', '');
    if (state.fill) el.setAttribute('data-fp-fill', '');
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
    state.agents.clear();
    state.mainFrame = null;
    state.lag = null;
    state.frozen = false;
    resetHealth(GRACE_MS);
  }

  function attachVideoListeners(v) {
    const h = () => pushState();
    ['play', 'pause', 'ratechange'].forEach((ev) => v.addEventListener(ev, h));
    state.videoListeners = { v, h };
  }

  function detachVideoListeners() {
    const l = state.videoListeners;
    if (!l) return;
    ['play', 'pause', 'ratechange'].forEach((ev) => l.v.removeEventListener(ev, l.h));
    state.videoListeners = null;
  }

  function visuals(on) {
    state.visualsOn = on;
    if (on) {
      if (!document.getElementById(STYLE_ID)) {
        const s = document.createElement('style');
        s.id = STYLE_ID;
        s.textContent = PAGE_CSS;
        (document.head || document.documentElement).appendChild(s);
      }
      document.documentElement.setAttribute('data-fp-on', '');
    } else {
      document.documentElement.removeAttribute('data-fp-on');
      clearMarks();
    }
  }

  // ======================= talking to the video =======================
  // The background finds the frame that holds the video (only the page itself without
  // "Control embedded players"; every frame with it) and runs the command there.
  async function video(cmd, arg) {
    const frameId = isVideo(state.target) ? 0 : state.mode === 'theater' ? state.mainFrame : null;
    return (await bg({ fp: 'video', cmd, arg, frameId })) || { ok: false, error: 'unreachable' };
  }

  function noVideoMessage(r) {
    if (r.error === 'no-video' && !settings.deep) return 'Can’t reach this player. Turn on “Control embedded players” in the popup.';
    if (r.error === 'no-video') return 'No video found';
    if (r.error === 'pip') return 'Picture-in-picture isn’t available for this video';
    return 'That didn’t work on this page';
  }

  async function speedCmd(cmd, arg) {
    const r = await video(cmd, arg);
    if (!r.ok) {
      toast(noVideoMessage(r));
      return r;
    }
    state.speed = r.rate;
    const speeds = { ...settings.speeds };
    if (Math.abs(r.rate - 1) < 0.01) delete speeds[location.origin];
    else speeds[location.origin] = r.rate;
    settings.speeds = speeds;
    chrome.storage.local.set({ speeds }).catch(() => {});
    toast(`Speed ${fmtRate(r.rate)}×`);
    return r;
  }

  async function applySavedSpeed() {
    const sp = settings.speeds[location.origin];
    if (!sp || Math.abs(sp - 1) < 0.01) return;
    const r = await video('speed', sp);
    if (r.ok) {
      state.speed = r.rate;
      pushState();
    }
  }

  // ======================= Deep reports (Control embedded players) =======================
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
      let lag = null; // only live streams (no fixed length) have a "live edge" to fall behind
      try {
        const s = t.seekable;
        if (!isFinite(t.duration) && s && s.length) {
          const e = s.end(s.length - 1);
          if (isFinite(e)) lag = e - t.currentTime;
        }
      } catch (_) {}
      return { paused: t.paused || t.ended, t: t.currentTime, lag, rate: t.playbackRate, via: 'video' };
    }
    const a = mainAgent();
    if (a) return { paused: a.paused || a.ended, t: a.t, lag: a.lag, rate: a.rate, via: 'deep' };
    return null;
  }

  chrome.runtime.onMessage.addListener((m) => {
    if (!m) return;
    if (m.fp === 'blocked-tab') {
      toast('Blocked a pop-up tab');
      return;
    }
    if (m.fp !== 'agent-report' || state.mode !== 'theater') return;
    state.agents.set(m.frameId, { ...m, at: Date.now() });
    const a = mainAgent();
    const fid = a ? a.frameId : null;
    if (fid !== state.mainFrame) {
      state.mainFrame = fid;
      bg({ fp: 'main-frame', frameId: fid });
    }
    if (a && typeof a.rate === 'number') state.speed = a.rate;
    pushState();
  });

  // ======================= follow the player if the site swaps it =======================
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
    if (state.mode !== 'theater' || (state.target && state.target.isConnected)) return true;
    const c = chooseTarget();
    if (!c.el) return false;
    state.candidates = c.list.filter((i) => i.ok).map((i) => i.el);
    state.idx = Math.max(0, state.candidates.indexOf(c.el));
    setTarget(c.el);
    bg({ fp: 'agents-refresh' });
    later(applySavedSpeed, 1500);
    pushState();
    return true;
  }

  // ======================= stream health =======================
  function resetHealth(grace) {
    wd.stillSince = 0;
    wd.lastT = null;
    wd.stage = 0;
    wd.graceUntil = Date.now() + (grace || 0);
    bg({ fp: 'frame-reset' });
  }

  function startHealth() {
    stopHealth();
    wd.fixes = [];
    resetHealth(GRACE_MS);
    wd.timer = setInterval(tick, TICK_MS);
  }

  function stopHealth() {
    clearInterval(wd.timer);
    wd.timer = null;
  }

  async function tick() {
    if (state.mode !== 'theater' || wd.busy) return;
    const now = Date.now();

    if (!state.target || !state.target.isConnected) {
      if (!retarget()) {
        if (!state.lostSince) state.lostSince = now;
        else if (now - state.lostSince > 10000) showWait();
      }
      return;
    }
    state.lostSince = 0;

    if (settings.deep && !isVideo(state.target) && !mainAgent() && now - state.agentAsk > 10000) {
      state.agentAsk = now;
      bg({ fp: 'agents-refresh' });
    }

    const pv = playbackView();
    const lag = pv && pv.lag != null && pv.lag > LIVE_BEHIND_S ? Math.round(pv.lag) : null;
    if (lag !== state.lag) {
      state.lag = lag;
      pushState();
    }

    if (!settings.recover || document.visibilityState !== 'visible' || now < wd.graceUntil) {
      wd.stillSince = 0;
      wd.lastT = null;
      return;
    }

    let moving = null;
    if (pv) {
      wd.via = pv.via;
      // Paused is your choice (or the player's): leave it alone.
      if (pv.paused) { wd.stillSince = 0; wd.lastT = null; return; }
      moving = wd.lastT === null ? null : pv.t !== wd.lastT;
      wd.lastT = pv.t;
    } else {
      // Can't see inside this player: compare tiny snapshots of the tab. We can't tell
      // "paused" from "frozen" this way, so we only offer a Reload button.
      wd.via = 'snapshot';
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
      if (moving === null) return;
      if (moving) {
        wd.stillSince = 0;
        if (state.frozen) { state.frozen = false; styleUI(); pushState(); }
        return;
      }
      if (!wd.stillSince) wd.stillSince = now;
      if (!state.frozen && now - wd.stillSince >= FROZEN_HINT_MS) {
        state.frozen = true;
        styleUI();
        pushState({ wake: true });
      }
      return;
    }

    if (moving === null) return;
    if (moving) { wd.stillSince = 0; wd.stage = 0; return; }
    if (!wd.stillSince) wd.stillSince = now;
    if (now - wd.stillSince >= (wd.stage ? STALL_MS / 2 : STALL_MS)) {
      wd.stillSince = 0;
      recover();
    }
  }

  async function recover() {
    const now = Date.now();
    wd.fixes = wd.fixes.filter((t) => now - t < FIX_WINDOW_MS);
    if (wd.fixes.length >= MAX_FIXES) {
      wd.graceUntil = now + 60000;
      toast('This stream keeps stalling. It may be down.');
      return;
    }
    if (wd.stage === 0) {
      wd.stage = 1;
      wd.graceUntil = now + 5000;
      toast('Stream stalled. Catching up…');
      await video('jumplive');
      return;
    }
    wd.fixes.push(now);
    reloadPlayer(true);
  }

  function reloadPlayer(auto) {
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
        const t = el.currentTime;
        el.load();
        if (!isFinite(el.duration) || auto) el.play().catch(() => {});
        else el.currentTime = t;
      } else ok = false;
    } else {
      const clone = el.cloneNode(true);
      el.replaceWith(clone);
      setTarget(clone);
    }
    state.agents.clear();
    state.frozen = false;
    styleUI();
    resetHealth(GRACE_MS);
    later(() => bg({ fp: 'agents-refresh' }), 2500);
    later(applySavedSpeed, 3000);
    toast(ok ? (auto ? 'Stream stalled. Restarting the player…' : 'Restarting the player…') : 'This player can’t be restarted. Reload the page.');
  }

  // ======================= the control pill (extension iframe) =======================
  function ensureUI() {
    if (state.frame && state.frame.isConnected) return;
    state.frameReady = false;
    const f = document.createElement('iframe');
    f.src = UI_URL;
    f.setAttribute('allowtransparency', 'true');
    f.setAttribute('aria-label', 'Focus Player controls');
    f.setAttribute('data-fp-ui', '');
    state.frame = f;
    styleUI();
    document.documentElement.appendChild(f);
  }

  function removeUI() {
    state.frame?.remove();
    state.frame = null;
    state.frameReady = false;
  }

  function uiMode() {
    if (state.mode === 'theater') return state.menuOpen ? 'menu' : state.frozen ? 'frozen' : 'theater';
    return state.mode; // wait | pick | suggest
  }

  function styleUI() {
    const f = state.frame;
    if (!f) return;
    const base = {
      position: 'fixed', border: '0', margin: '0', padding: '0', 'z-index': '2147483647',
      background: 'transparent', 'color-scheme': 'light', display: 'block', visibility: 'visible',
      opacity: '1', 'max-width': 'none', 'max-height': 'none', 'pointer-events': 'auto',
      transform: 'none', right: 'auto', bottom: 'auto', 'box-shadow': 'none',
    };
    const top = (w, h) => ({ top: '10px', left: `calc(50vw - min(${w / 2}px, 48vw))`, width: `min(${w}px, 96vw)`, height: `${h}px`, 'border-radius': '16px' });
    const boxes = {
      theater: top(520, 56),
      frozen: top(520, 112),
      menu: top(520, 300),
      wait: top(520, 56),
      pick: { top: '0', left: '0', width: '100vw', height: '100vh', 'border-radius': '0' },
      suggest: { top: 'calc(100vh - 84px)', left: 'calc(100vw - 344px)', width: '324px', height: '64px', 'border-radius': '16px' },
    };
    const box = boxes[uiMode()] || boxes.theater;
    for (const [k, v] of Object.entries({ ...base, ...box })) f.style.setProperty(k, v, 'important');
  }

  function pushState(extra) {
    const f = state.frame;
    if (!f || !f.contentWindow || !state.frameReady) return;
    const pv = state.mode === 'theater' ? playbackView() : null;
    f.contentWindow.postMessage(
      {
        __fp: 'state',
        ui: uiMode(),
        speed: fmtRate(pv && typeof pv.rate === 'number' ? pv.rate : state.speed),
        lag: state.lag,
        multi: state.candidates.length > 1,
        fullscreen: !!document.fullscreenElement,
        fill: state.fill,
        deep: !!settings.deep,
        host: location.hostname,
        waitLong: Date.now() - state.waitStart > 45000,
        suggestLabel: state.suggestEl ? describe(state.suggestEl) : '',
        ...(extra || {}),
      },
      EXT_ORIGIN
    );
  }

  function toast(text) {
    if (state.frame && state.frameReady && (state.mode === 'theater' || state.mode === 'pick')) pushState({ toast: text });
    else pageToast(text);
  }

  function onUIMessage(e) {
    if (!state.frame || e.source !== state.frame.contentWindow || e.origin !== EXT_ORIGIN) return;
    const d = e.data;
    if (!d || d.__fp !== true) return;
    switch (d.cmd) {
      case 'ready':
        state.frameReady = true;
        pushState({ wake: true });
        break;
      case 'exit': exitAll(false); break;
      case 'dismiss': exitAll(true); break;
      case 'faster': case 'slower': case 'reset-speed': speedCmd(d.cmd); break;
      case 'pip': pipCmd(); break;
      case 'live':
        video('jumplive').then((r) => { if (r.ok) { state.lag = null; pushState({ toast: 'Live' }); } });
        break;
      case 'fullscreen': toggleFullscreen(); break;
      case 'fill': fillCmd(); break;
      case 'menu': state.menuOpen = !!d.open; styleUI(); pushState(); break;
      case 'reload': state.menuOpen = false; styleUI(); reloadPlayer(false); break;
      case 'next': state.menuOpen = false; styleUI(); next(); break;
      case 'pick': showPick(); break;
      case 'settings': state.menuOpen = false; styleUI(); pushState(); bg({ fp: 'open-options' }); break;
      case 'frozen-dismiss': state.frozen = false; wd.stillSince = Date.now(); styleUI(); pushState(); break;
      case 'focusNow': {
        const c = chooseTarget();
        if (c.el) enterTheater(c.el, c.why);
        break;
      }
      case 'hover': {
        const el = mediaAt(d.x, d.y);
        if (!el) { pushState({ hover: null }); break; }
        const r = el.getBoundingClientRect();
        const i = rate(el);
        const label = `${el.tagName === 'VIDEO' ? 'Video' : 'Player'} ${Math.round(r.width)}×${Math.round(r.height)}${i.ok ? '' : ' · probably not the main video'}`;
        pushState({ hover: { x: r.left, y: r.top, w: r.width, h: r.height, label, warn: !i.ok } });
        break;
      }
      case 'pickAt': {
        const el = mediaAt(d.x, d.y);
        if (!el) { pushState({ toast: 'No video there. Click right on the video.' }); break; }
        state.lastList = candidates();
        rememberPick(el);
        enterTheater(el, 'picked');
        break;
      }
      case 'pickCancel': {
        const t = state.prevTarget;
        if (t && t.isConnected) enterTheater(t, 'back');
        else exitAll(false);
        break;
      }
    }
  }
  window.addEventListener('message', onUIMessage, true);

  async function pipCmd() {
    const r = await video('pip');
    if (!r.ok) toast(noVideoMessage(r));
  }

  async function fillCmd() {
    state.fill = !state.fill;
    if (state.target) {
      if (state.fill) state.target.setAttribute('data-fp-fill', '');
      else state.target.removeAttribute('data-fp-fill');
    }
    if (!isVideo(state.target)) await video('fill', state.fill);
    state.menuOpen = false;
    styleUI();
    pushState({ toast: state.fill ? 'Zoom: fill the screen' : 'Zoom: fit the whole picture' });
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => toast('Full screen was blocked. Try F11, or Ctrl+Cmd+F on a Mac.'));
  }
  document.addEventListener('fullscreenchange', () => pushState(), true);

  function next() {
    state.candidates = state.candidates.filter((el) => el.isConnected);
    if (state.candidates.length < 2) {
      toast('Only one video on this page');
      return;
    }
    state.idx = (state.idx + 1) % state.candidates.length;
    setTarget(state.candidates[state.idx]);
    bg({ fp: 'agents-refresh' });
    pushState({ toast: `Video ${state.idx + 1} of ${state.candidates.length}` });
  }

  // ======================= modes =======================
  function status() {
    bg({ fp: 'status', mode: state.mode });
  }

  function clearTimers() {
    state.timers.forEach(clearTimeout);
    state.timers = [];
  }

  function leaveTheater() {
    clearTimers();
    stopHealth();
    stopObserver();
    visuals(false);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  function describe(el) {
    const r = el.getBoundingClientRect();
    return `${el.tagName === 'VIDEO' ? 'Video' : 'Player'} ${Math.round(r.width)}×${Math.round(r.height)}`;
  }

  async function enterTheater(el, why) {
    stopWaitPoll();
    clearTimers();
    // Some players pause themselves when they're resized. Note whether it was playing so we can undo that.
    const before = await video('state');
    state.mode = 'theater';
    state.menuOpen = false;
    state.frozen = false;
    const good = (state.lastList || []).filter((i) => i.ok || i.el === el).map((i) => i.el);
    if (!good.includes(el)) good.unshift(el);
    state.candidates = good;
    state.idx = good.indexOf(el);
    state.prevTarget = el;
    if (before.ok) state.speed = before.rate;
    visuals(true);
    setTarget(el);
    ensureUI();
    styleUI();
    startObserver();
    startHealth();
    status();
    const toasts = { picked: 'Got it. This video will be used on this site from now on.', remembered: 'Using the video you picked for this site' };
    pushState({ wake: true, ...(toasts[why] ? { toast: toasts[why] } : {}) });
    if (before.ok && !before.paused) {
      const resume = async () => {
        if (state.mode !== 'theater') return;
        const now = await video('state');
        if (now.ok && now.paused && !now.ended) video('play');
      };
      later(resume, 1200);
      later(resume, 3000);
    }
    later(applySavedSpeed, 600);
    later(applySavedSpeed, 3000);
  }

  function showWait() {
    leaveTheater();
    state.mode = 'wait';
    state.menuOpen = false;
    ensureUI();
    styleUI();
    startWaitPoll();
    status();
    pushState();
  }

  function showPick() {
    leaveTheater();
    stopWaitPoll();
    state.mode = 'pick';
    state.menuOpen = false;
    // Start a fresh full-window layer: Chrome can take a moment to route the mouse into a
    // frame that has just been enlarged, which would make the first hovers and clicks miss.
    removeUI();
    ensureUI();
    styleUI();
    status();
    pushState();
  }

  // Quietly watch the page for a video (Button / Always sites).
  function arm(kind) {
    state.mode = 'armed';
    state.armKind = kind;
    state.suggestEl = null;
    removeUI();
    startWaitPoll();
    status();
  }

  function showSuggest(el) {
    state.mode = 'suggest';
    state.suggestEl = el;
    ensureUI();
    styleUI();
    status();
    pushState();
  }

  // hard = off for this page. Otherwise, on Button/Always sites, the Theater button comes back.
  function exitAll(hard) {
    leaveTheater();
    stopWaitPoll();
    removeUI();
    state.target = null;
    state.candidates = [];
    state.agents.clear();
    state.suggestEl = null;
    state.menuOpen = false;
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
    if (state.mode === 'wait' && (now - state.waitStart) % 15000 < 1000) pushState();
    const el = c.el;
    if (!el) { state.pending = null; return; }
    if (!state.pending || state.pending.el !== el) {
      state.pending = { el, since: now };
      return;
    }
    if (now - state.pending.since >= 1200) {
      if (state.mode === 'armed' && state.armKind === 'suggest') showSuggest(el);
      else enterTheater(el, c.why);
    }
  }

  async function start(trigger) {
    await settingsReady;
    if (state.mode === 'theater' || state.mode === 'wait' || state.mode === 'pick') return;
    if (trigger === 'page-load') {
      const m = siteMode();
      if (m !== 'off') arm(m === 'auto' ? 'auto' : 'suggest');
      return;
    }
    const c = chooseTarget();
    if (c.el) enterTheater(c.el, c.why);
    else showWait();
  }

  // Note clicks inside the page or the player while in theater mode: a new tab that appears right
  // after one is a pop-up, and the background closes it. (Clicking into an embedded player moves
  // the keyboard focus into it, which is how a click there can be seen from here.)
  const notePageClick = () => { if (state.mode === 'theater') bg({ fp: 'page-click' }); };
  document.addEventListener('pointerdown', (e) => { if (e.isTrusted && !(e.target && e.target.hasAttribute && e.target.hasAttribute('data-fp-ui'))) notePageClick(); }, true);
  window.addEventListener('blur', () => setTimeout(() => { if (document.activeElement && document.activeElement.tagName === 'IFRAME' && !document.activeElement.hasAttribute('data-fp-ui')) notePageClick(); }, 0));

  // Esc leaves theater / pick mode when the page itself has the keyboard.
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (state.mode === 'pick') onUIMessage({ source: state.frame?.contentWindow, origin: EXT_ORIGIN, data: { __fp: true, cmd: 'pickCancel' } });
      else if (state.mode === 'theater' && !document.fullscreenElement) exitAll(false);
    },
    true
  );

  // ======================= diagnostics =======================
  function diagnostics() {
    const now = Date.now();
    const L = [];
    const chromeV = (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || '?';
    L.push(`Focus Player ${VERSION} diagnostics`);
    L.push(`Site: ${location.hostname}   Mode: ${state.mode}   Window: ${innerWidth}x${innerHeight}   Chrome ${chromeV}`);
    L.push(`Settings: this site ${siteMode()} | recover ${settings.recover ? 'on' : 'off'} | mute others ${settings.silence ? 'on' : 'off'} | block ads ${settings.blockAds ? 'on' : 'off'} | embedded control ${settings.deep ? 'on' : 'off'} | speed ${fmtRate(state.speed)}x | picked ${settings.picks[location.hostname] ? 'yes' : 'no'}`);
    const list = state.lastList && state.lastList.length ? state.lastList : candidates();
    L.push('Players (best first):');
    list.slice(0, 8).forEach((i, n) => {
      L.push(`  ${n + 1}. ${i.tag} ${i.w}x${i.h} score ${Math.round(i.score)} host ${i.srcHost || '-'} [${i.reasons.join(', ') || '-'}]${i.el === state.target ? '  <- showing' : ''}`);
    });
    if (!list.length) L.push('  (none)');
    const ags = [...state.agents.values()].filter((a) => now - a.at < AGENT_FRESH_MS);
    L.push(`Embedded frames reporting: ${ags.length}`);
    ags.forEach((a) =>
      L.push(`  frame ${a.frameId}: ${a.hasVideo ? `video ${a.w}x${a.h} ${a.paused ? 'paused' : 'playing'} t=${(a.t || 0).toFixed(1)} rate=${a.rate} behind-live ${a.lag == null ? '-' : a.lag.toFixed(1) + 's'} ready=${a.rs}` : 'no video'}`)
    );
    L.push(`Health: restarts in last 3 min ${wd.fixes.filter((x) => now - x < FIX_WINDOW_MS).length} | via ${wd.via || '-'} | last snapshot change ${wd.lastDiff == null ? '-' : wd.lastDiff.toFixed(2)} | frozen hint ${state.frozen ? 'yes' : 'no'}`);
    return L.join('\n');
  }

  function pageToast(text) {
    const host = document.createElement('div');
    host.setAttribute('data-fp-ui', '');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      div{position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:2147483647;
      background:rgba(17,20,25,.92);color:#fff;font:600 14px/1.3 system-ui,-apple-system,sans-serif;padding:11px 16px;
      border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.35);max-width:80vw;text-align:center;pointer-events:none}</style><div></div>`;
    root.querySelector('div').textContent = text;
    document.documentElement.appendChild(host);
    setTimeout(() => host.remove(), 2200);
  }

  // ======================= toolbar popup / shortcuts =======================
  function info() {
    let found = null;
    if (state.mode === 'theater' && state.target) found = { label: describe(state.target), ok: true };
    else {
      const c = chooseTarget();
      if (c.el) found = { label: describe(c.el), ok: true };
      else if (c.list.length) found = { label: describe(c.list[0].el), ok: false };
    }
    return {
      mode: state.mode,
      found,
      siteMode: siteMode(),
      picked: !!settings.picks[location.hostname],
      origin: location.origin,
      host: location.hostname,
    };
  }

  async function handle(action) {
    await settingsReady;
    switch (action) {
      case 'info': {
        const i = info();
        const v = await video('state');
        i.rate = v.ok ? fmtRate(v.rate) : null;
        i.hasVideo = !!v.ok;
        return i;
      }
      case 'toggle':
        if (state.mode === 'theater' || state.mode === 'wait' || state.mode === 'pick') exitAll(false);
        else start('user');
        break;
      case 'theater': if (state.mode !== 'theater') start('user'); break;
      case 'exit': if (state.mode !== 'off') exitAll(false); break;
      case 'page-load': start('page-load'); break;
      case 'site-changed':
        settings.siteModes = (await chrome.storage.local.get('siteModes')).siteModes || {};
        if (state.mode === 'off' || state.mode === 'armed' || state.mode === 'suggest') {
          if (siteMode() === 'off') { if (state.mode !== 'off') exitAll(true); }
          else arm(siteMode() === 'auto' ? 'auto' : 'suggest');
        }
        break;
      case 'pick': showPick(); break;
      case 'next': if (state.mode === 'theater') next(); break;
      case 'reload': if (state.mode === 'theater') reloadPlayer(false); break;
      case 'faster': case 'slower': case 'reset-speed': {
        const r = await speedCmd(action);
        return { ...info(), rate: r.ok ? fmtRate(r.rate) : null, hasVideo: !!r.ok };
      }
      case 'fill': if (state.mode === 'theater') await fillCmd(); break;
      case 'diag': return { ...info(), diag: diagnostics() };
      case 'forget': {
        const picks = { ...settings.picks };
        delete picks[location.hostname];
        settings.picks = picks;
        await chrome.storage.local.set({ picks });
        break;
      }
    }
    return info();
  }

  window.__focusPlayer = { handle };
})();
