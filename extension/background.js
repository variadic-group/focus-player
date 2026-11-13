// Focus Player — background service worker.
//
// Default reach: only the tab you act on (activeTab), only when you click or press a shortcut.
// Optional reach you approve in Chrome's own prompt:
//   - Button / Always on a site     -> that one site
//   - Control embedded players      -> all sites (used only in tabs where theater mode is on,
//                                      or when you press a Focus Player button or shortcut)

// ---------------------------------------------------------------- tab state (survives the worker sleeping)
const modeCache = new Map();

async function getMode(tabId) {
  if (modeCache.has(tabId)) return modeCache.get(tabId);
  const k = 'mode:' + tabId;
  const s = await chrome.storage.session.get(k);
  const m = s[k] || 'off';
  modeCache.set(tabId, m);
  return m;
}

async function setMode(tabId, mode) {
  modeCache.set(tabId, mode);
  const k = 'mode:' + tabId;
  if (mode === 'off') await chrome.storage.session.remove(k);
  else await chrome.storage.session.set({ [k]: mode });
}

const frameInfo = new Map(); // tabId -> { frames:Set, main:frameId|null, silenced:Set }
function fi(tabId) {
  let t = frameInfo.get(tabId);
  if (!t) frameInfo.set(tabId, (t = { frames: new Set(), main: null, silenced: new Set() }));
  return t;
}

async function deepAllowed() {
  const { deep } = await chrome.storage.local.get('deep');
  if (!deep) return false;
  return chrome.permissions.contains({ origins: ['<all_urls>'] });
}

// ---------------------------------------------------------------- running content-script actions
async function runInTab(tabId, action) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (a) => window.__focusPlayer.handle(a),
    args: [action],
  });
  return r && r.result;
}

async function run(tab, action) {
  if (!tab || tab.id == null) return;
  try {
    await runInTab(tab.id, action);
  } catch (e) {
    console.warn('Focus Player could not run on this page:', e && e.message);
  }
}

// ---------------------------------------------------------------- video commands (run inside the frame that has the video)
// Runs in the page. Finds the video Focus Player is showing (or the biggest one) and acts on it.
function pageVideoCommand(cmd, arg) {
  const vids = [];
  const walk = (root) => {
    root.querySelectorAll('video').forEach((v) => vids.push(v));
    root.querySelectorAll('*').forEach((el) => el.shadowRoot && walk(el.shadowRoot));
  };
  walk(document);
  let v = null;
  let score = 0;
  for (const x of vids) {
    const r = x.getBoundingClientRect();
    let s = r.width * r.height;
    if (!s) continue;
    if (!x.paused) s *= 3;
    if (x.readyState >= 2) s *= 1.5;
    if (x.muted && x.loop) s *= 0.3;
    if (x.hasAttribute('data-fp-target')) s *= 100; // the one Focus Player is showing always wins
    if (s > score) { score = s; v = x; }
  }
  if (!v) return { ok: false, error: 'no-video' };
  const STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
  const lag = () => {
    try {
      const s = v.seekable;
      if (!isFinite(v.duration) && s && s.length) {
        const e = s.end(s.length - 1);
        if (isFinite(e)) return e - v.currentTime;
      }
    } catch (_) {}
    return null;
  };
  const out = () => ({
    ok: true, score, rate: v.playbackRate, paused: v.paused, ended: v.ended, lag: lag(),
    fill: v.style.objectFit === 'cover', pip: !!document.pictureInPictureElement,
  });
  switch (cmd) {
    case 'speed': v.playbackRate = Math.min(16, Math.max(0.0625, Number(arg) || 1)); break;
    case 'faster': { const c = v.playbackRate; const n = STEPS.find((s) => s > c + 0.001); if (n) v.playbackRate = n; break; }
    case 'slower': { const c = v.playbackRate; const n = [...STEPS].reverse().find((s) => s < c - 0.001); if (n) v.playbackRate = n; break; }
    case 'reset-speed': v.playbackRate = 1; break;
    case 'play': v.play().catch(() => {}); break;
    case 'jumplive': {
      const l = lag();
      if (l != null && l > 3) v.currentTime = v.seekable.end(v.seekable.length - 1) - 2;
      v.play().catch(() => {});
      break;
    }
    case 'fill':
      if (!v.hasAttribute('data-fp-target')) {
        if (arg) v.style.setProperty('object-fit', 'cover', 'important');
        else v.style.removeProperty('object-fit');
      }
      break;
    case 'pip':
      return (async () => {
        try {
          if (document.pictureInPictureElement) await document.exitPictureInPicture();
          else {
            v.disablePictureInPicture = false;
            await v.requestPictureInPicture();
          }
          return out();
        } catch (e) {
          return { ok: false, error: 'pip', detail: String((e && e.message) || e) };
        }
      })();
  }
  return out();
}

async function videoCommand(tabId, cmd, arg, frameId) {
  arg = arg === undefined ? null : arg; // executeScript can't pass `undefined`
  let target = frameId;
  if (target == null) {
    let results = [];
    try {
      results = await chrome.scripting.executeScript({ target: { tabId, allFrames: await deepAllowed() }, func: pageVideoCommand, args: ['state', null] });
    } catch (_) {
      try {
        results = await chrome.scripting.executeScript({ target: { tabId }, func: pageVideoCommand, args: ['state', null] });
      } catch (e) {
        return { ok: false, error: 'no-access' };
      }
    }
    let best = null;
    for (const r of results) if (r.result && r.result.ok && (!best || r.result.score > best.result.score)) best = r;
    if (!best) return { ok: false, error: 'no-video' };
    if (cmd === 'state') return { ...best.result, frameId: best.frameId };
    target = best.frameId;
  }
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [target] }, func: pageVideoCommand, args: [cmd, arg] });
    const res = (r && r.result) || { ok: false, error: 'no-video' };
    if (!res.ok && res.error === 'no-video' && frameId != null) return videoCommand(tabId, cmd, arg, null);
    return { ...res, frameId: target };
  } catch (_) {
    if (frameId != null) return videoCommand(tabId, cmd, arg, null);
    return { ok: false, error: 'no-access' };
  }
}

// ---------------------------------------------------------------- in-page guards while in theater mode (MAIN world)
function popupGuard(on) {
  const KEY = '__fpPopupGuard';
  const w = window;
  if (on && !w[KEY]) {
    const origOpen = w.open;
    const origClick = HTMLAnchorElement.prototype.click;
    w[KEY] = { origOpen, origClick };
    w.open = function () {
      console.info('[Focus Player] blocked a pop-up');
      return null;
    };
    HTMLAnchorElement.prototype.click = function () {
      if (String(this.target || '').toLowerCase() === '_blank') return;
      return origClick.call(this);
    };
  } else if (!on && w[KEY]) {
    w.open = w[KEY].origOpen;
    HTMLAnchorElement.prototype.click = w[KEY].origClick;
    delete w[KEY];
  }
}

// Mutes every other sound in the frame (ads, chat pings) while the video you're watching keeps its sound.
function silencer(on) {
  const KEY = '__fpSilencer';
  const w = window;
  if (on && !w[KEY]) {
    const keep = (el) => !!(el.closest && el.closest('[data-fp-target]'));
    const hush = (el) => {
      if (keep(el) || el.muted) return;
      el.muted = true;
      el.setAttribute('data-fp-hushed', '');
    };
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      try { hush(this); } catch (_) {}
      return origPlay.apply(this, arguments);
    };
    document.querySelectorAll('audio, video').forEach((el) => { try { hush(el); } catch (_) {} });
    const AS = w.AudioScheduledSourceNode;
    const origStart = AS && AS.prototype.start;
    if (AS) AS.prototype.start = function () {};
    w[KEY] = { origPlay, origStart };
  } else if (!on && w[KEY]) {
    HTMLMediaElement.prototype.play = w[KEY].origPlay;
    if (w[KEY].origStart) w.AudioScheduledSourceNode.prototype.start = w[KEY].origStart;
    document.querySelectorAll('[data-fp-hushed]').forEach((el) => {
      el.muted = false;
      el.removeAttribute('data-fp-hushed');
    });
    delete w[KEY];
  }
}

async function applyGuard(tabId, on) {
  const allFrames = await deepAllowed();
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames }, world: 'MAIN', func: popupGuard, args: [on] });
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: popupGuard, args: [on] });
    } catch (e) {}
  }
}

const silenceTimers = new Map();
function scheduleSilence(tabId) {
  clearTimeout(silenceTimers.get(tabId));
  silenceTimers.set(tabId, setTimeout(() => applySilence(tabId), 150));
}

async function applySilence(tabId) {
  const mode = await getMode(tabId);
  const { silence } = await chrome.storage.local.get('silence');
  const t = fi(tabId);
  const wanted = new Set();
  if (silence !== false && mode === 'theater') {
    wanted.add(0);
    if (t.main != null && (await deepAllowed())) for (const f of t.frames) if (f !== t.main && f !== 0) wanted.add(f);
  }
  for (const f of wanted) {
    if (t.silenced.has(f)) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [f] }, world: 'MAIN', func: silencer, args: [true] });
      t.silenced.add(f);
    } catch (_) {}
  }
  for (const f of [...t.silenced]) {
    if (wanted.has(f)) continue;
    t.silenced.delete(f);
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [f] }, world: 'MAIN', func: silencer, args: [false] });
    } catch (_) {}
  }
}

async function injectAgents(tabId) {
  if ((await getMode(tabId)) !== 'theater' || !(await deepAllowed())) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['agent.js'] });
  } catch (_) {}
  applyGuard(tabId, true);
}

async function setBadge(tabId, mode) {
  const text = { theater: 'ON', wait: '…', suggest: '▶', pick: '•' }[mode] || '';
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#1f9d55' });
    await chrome.action.setBadgeText({ tabId, text });
  } catch (_) {}
}

// ---------------------------------------------------------------- frozen-picture check (no embedded access)
// Compares a 48x27 grey thumbnail of the visible tab with the previous one. In memory only.
const lastThumb = new Map();
const TW = 48;
const TH = 27;

async function frameDiff(tab) {
  if (!tab.active) return { skip: true };
  const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 40 });
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob, { resizeWidth: TW, resizeHeight: TH, resizeQuality: 'low' });
  const canvas = new OffscreenCanvas(TW, TH);
  const g = canvas.getContext('2d');
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const px = g.getImageData(0, 0, TW, TH).data;
  const grey = new Uint8Array(TW * TH);
  for (let i = 0; i < grey.length; i++) grey[i] = (px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11) | 0;
  const prev = lastThumb.get(tab.id);
  lastThumb.set(tab.id, grey);
  if (!prev) return { diff: null };
  let sum = 0;
  for (let i = 0; i < grey.length; i++) sum += Math.abs(grey[i] - prev[i]);
  return { diff: sum / grey.length };
}

// ---------------------------------------------------------------- ads & pop-ups
async function syncAdBlock() {
  const { blockAds } = await chrome.storage.local.get('blockAds');
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets(blockAds !== false ? { enableRulesetIds: ['ads'] } : { disableRulesetIds: ['ads'] });
  } catch (_) {}
}

// In theater mode the page is hidden, so a new tab that the page opens right after a click
// inside it (the classic "click anywhere" pop-up) is closed. Tabs you open yourself are untouched.
let allowOwnTabsUntil = 0;
const lastPageClick = new Map(); // tabId -> time of the last click inside the page or player
chrome.tabs.onCreated.addListener(async (tab) => {
  const opener = tab.openerTabId;
  if (opener == null || Date.now() < allowOwnTabsUntil) return;
  if ((await getMode(opener)) !== 'theater') return;
  await new Promise((r) => setTimeout(r, 300)); // the "you clicked" note can arrive just after the tab
  if (Date.now() - (lastPageClick.get(opener) || 0) > 3000) return;
  const { blockAds } = await chrome.storage.local.get('blockAds');
  if (blockAds === false) return;
  try {
    await chrome.tabs.remove(tab.id);
  } catch (_) {
    return;
  }
  chrome.tabs.update(opener, { active: true }).catch(() => {});
  chrome.tabs.sendMessage(opener, { fp: 'blocked-tab' }, { frameId: 0 }).catch(() => {});
});

function openOwn(url) {
  allowOwnTabsUntil = Date.now() + 4000;
  if (url) chrome.tabs.create({ url });
  else chrome.runtime.openOptionsPage();
}

// ---------------------------------------------------------------- Button / Always sites
async function migrate() {
  const s = await chrome.storage.local.get(['autoSites', 'siteModes', 'autofix', 'recover']);
  if (s.autoSites && s.autoSites.length && !s.siteModes) {
    const m = {};
    for (const o of s.autoSites) m[o] = 'auto';
    await chrome.storage.local.set({ siteModes: m });
  }
  if (s.autofix === false && s.recover === undefined) await chrome.storage.local.set({ recover: false });
  await chrome.storage.local.remove(['autoSites', 'autofix', 'lockStyle']);
}

async function syncSiteScripts() {
  const { siteModes = {} } = await chrome.storage.local.get('siteModes');
  const origins = Object.keys(siteModes).filter((o) => siteModes[o] && siteModes[o] !== 'off');
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ['fp-auto'] });
  } catch (_) {}
  if (!origins.length) return;
  try {
    await chrome.scripting.registerContentScripts([
      { id: 'fp-auto', matches: origins.map((o) => o + '/*'), js: ['content.js', 'auto.js'], runAt: 'document_idle', persistAcrossSessions: true },
    ]);
  } catch (e) {
    console.warn('Focus Player: site registration failed:', e && e.message);
  }
}

async function setup() {
  await migrate();
  await syncSiteScripts();
  await syncAdBlock();
}
chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  if ('siteModes' in ch) syncSiteScripts();
  if ('blockAds' in ch) syncAdBlock();
  if ('silence' in ch || 'deep' in ch) for (const [tabId, m] of modeCache) if (m === 'theater') scheduleSilence(tabId);
});

// ---------------------------------------------------------------- message hub
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.fp === 'open-options') {
    openOwn();
    sendResponse({});
    return;
  }
  if (msg.fp === 'open-shortcuts') {
    openOwn('chrome://extensions/shortcuts');
    sendResponse({});
    return;
  }

  // From the toolbar popup.
  if (msg.fp === 'popup') {
    const p = msg.action === 'pip' ? videoCommand(msg.tabId, 'pip') : runInTab(msg.tabId, msg.action);
    p.then(
      (info) => sendResponse({ ok: true, info }),
      (e) => sendResponse({ ok: false, error: String((e && e.message) || e) })
    );
    return true;
  }

  if (!sender.tab) return;
  const tabId = sender.tab.id;

  switch (msg.fp) {
    case 'status': {
      if (sender.frameId !== 0) return;
      (async () => {
        const prev = await getMode(tabId);
        await setMode(tabId, msg.mode);
        setBadge(tabId, msg.mode);
        const on = msg.mode === 'theater';
        if (on !== (prev === 'theater')) applyGuard(tabId, on);
        if (on) injectAgents(tabId);
        else fi(tabId).main = null;
        if (msg.mode === 'off') lastThumb.delete(tabId);
        scheduleSilence(tabId);
        sendResponse({});
      })();
      return true;
    }
    case 'video':
      videoCommand(tabId, msg.cmd, msg.arg, msg.frameId).then(sendResponse);
      return true;
    case 'main-frame':
      fi(tabId).main = msg.frameId;
      scheduleSilence(tabId);
      sendResponse({});
      return;
    case 'agents-refresh':
      injectAgents(tabId);
      sendResponse({});
      return;
    case 'agent-report':
      if (sender.frameId === 0) return;
      (async () => {
        if ((await getMode(tabId)) !== 'theater') return sendResponse({ stop: true });
        const t = fi(tabId);
        if (!t.frames.has(sender.frameId)) {
          t.frames.add(sender.frameId);
          scheduleSilence(tabId);
        }
        chrome.tabs.sendMessage(tabId, { ...msg, frameId: sender.frameId }, { frameId: 0 }).catch(() => {});
        sendResponse({});
      })();
      return true;
    case 'page-click':
      lastPageClick.set(tabId, Date.now());
      sendResponse({});
      return;
    case 'frame-check':
      frameDiff(sender.tab).then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e) }));
      return true;
    case 'frame-reset':
      lastThumb.delete(tabId);
      sendResponse({});
      return;
  }
});

function forget(tabId) {
  lastThumb.delete(tabId);
  lastPageClick.delete(tabId);
  frameInfo.delete(tabId);
  setMode(tabId, 'off');
}
chrome.tabs.onRemoved.addListener(forget);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') forget(tabId);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (!tab || tab.id == null) return;
  if (command === 'pip') {
    videoCommand(tab.id, 'pip');
    return;
  }
  const map = {
    theater: 'toggle', faster: 'faster', slower: 'slower', 'reset-speed': 'reset-speed',
    'next-video': 'next', 'reload-player': 'reload', fill: 'fill',
  };
  if (map[command]) run(tab, map[command]);
});
