// Focus Player — background service worker.
//
// Default reach: only the tab you act on (activeTab), only when you click or press a shortcut.
// Optional reach you approve yourself in Chrome's prompt:
//   - Button/Auto on a site  -> access to that one site
//   - Deep mode              -> access to all sites (only used in tabs where Focus Player is on)

// ---------------------------------------------------------------- tab state
// Kept in session storage so it survives the service worker going to sleep.
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

const frameInfo = new Map(); // tabId -> { frames:Set<frameId>, main:frameId|null, silenced:Set<frameId> }
function fi(tabId) {
  let t = frameInfo.get(tabId);
  if (!t) frameInfo.set(tabId, (t = { frames: new Set(), main: null, silenced: new Set() }));
  return t;
}

const isActive = (m) => m && m !== 'off';

// ---------------------------------------------------------------- running actions in a tab
async function runInTab(tabId, action) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (a) => (a === 'info' ? window.__focusPlayer.info() : window.__focusPlayer.handle(a)),
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

async function deepAllowed() {
  const { deep } = await chrome.storage.local.get('deep');
  if (!deep) return false;
  return chrome.permissions.contains({ origins: ['<all_urls>'] });
}

// ---------------------------------------------------------------- in-page guards (MAIN world)
// While active: window.open and scripted target=_blank link clicks do nothing.
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
      if (String(this.target || '').toLowerCase() === '_blank') {
        console.info('[Focus Player] blocked a pop-up link');
        return;
      }
      return origClick.call(this);
    };
  } else if (!on && w[KEY]) {
    w.open = w[KEY].origOpen;
    HTMLAnchorElement.prototype.click = w[KEY].origClick;
    delete w[KEY];
  }
}

// While focused: every sound in this frame except the chosen player is muted,
// and Web Audio blips (chat pings, notification beeps) are swallowed.
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
    } catch (e) {
      console.warn('Focus Player: pop-up guard not applied:', e && e.message);
    }
  }
}

// Silence the top page always; with Deep mode also every other frame except the one playing the game.
let silenceTimer = new Map();
function scheduleSilence(tabId) {
  clearTimeout(silenceTimer.get(tabId));
  silenceTimer.set(tabId, setTimeout(() => applySilence(tabId), 150));
}

async function applySilence(tabId) {
  const mode = await getMode(tabId);
  const { silence } = await chrome.storage.local.get('silence');
  const want = silence !== false && mode === 'focus';
  const t = fi(tabId);
  const wanted = new Set();
  if (want) {
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
  if ((await getMode(tabId)) !== 'focus' || !(await deepAllowed())) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['agent.js'] });
  } catch (e) {
    console.warn('Focus Player: deep mode could not reach every frame:', e && e.message);
  }
  applyGuard(tabId, true);
}

async function setBadge(tabId, mode) {
  const text = { focus: 'ON', wait: '…', armed: '', suggest: '▶', pick: 'PICK' }[mode] || '';
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#22a35a' });
    await chrome.action.setBadgeText({ tabId, text });
  } catch (_) {}
}

// ---------------------------------------------------------------- freeze check without Deep mode
// Compares a 48x27 grey thumbnail of the visible tab with the previous one. Kept in memory only.
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

// ---------------------------------------------------------------- ad networks (declarativeNetRequest)
async function syncAdBlock() {
  const { blockAds } = await chrome.storage.local.get('blockAds');
  const on = blockAds !== false;
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets(on ? { enableRulesetIds: ['ads'] } : { disableRulesetIds: ['ads'] });
  } catch (e) {
    console.warn('Focus Player: could not update ad rules:', e && e.message);
  }
}

// ---------------------------------------------------------------- pop-up tab blocker
// A tab opened by a page where Focus Player is active gets closed straight away,
// unless you just clicked (or right-clicked) a real link that opens a new tab.
const allowTabUntil = new Map();
let allowOwnTabsUntil = 0; // our own Settings tab must never be mistaken for a pop-up

chrome.tabs.onCreated.addListener(async (tab) => {
  const opener = tab.openerTabId;
  if (opener == null) return;
  if (!isActive(await getMode(opener))) return;
  const { blockAds } = await chrome.storage.local.get('blockAds');
  if (blockAds === false) return;
  if (Date.now() < allowOwnTabsUntil) return;
  // The "you clicked a real link" note from the page can arrive a moment after the tab does.
  await new Promise((r) => setTimeout(r, 250));
  if ((allowTabUntil.get(opener) || 0) > Date.now()) {
    allowTabUntil.delete(opener);
    return;
  }
  try {
    await chrome.tabs.remove(tab.id);
  } catch (_) {
    return;
  }
  chrome.tabs.update(opener, { active: true }).catch(() => {});
  chrome.tabs.sendMessage(opener, { fp: 'blocked-tab' }, { frameId: 0 }).catch(() => {});
});

// ---------------------------------------------------------------- Button / Auto sites
async function migrate() {
  const { autoSites, siteModes } = await chrome.storage.local.get(['autoSites', 'siteModes']);
  if (autoSites && autoSites.length && !siteModes) {
    const m = {};
    for (const o of autoSites) m[o] = 'auto';
    await chrome.storage.local.set({ siteModes: m });
  }
  if (autoSites) await chrome.storage.local.remove('autoSites');
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

chrome.storage.onChanged.addListener(async (ch, area) => {
  if (area !== 'local') return;
  if ('siteModes' in ch) syncSiteScripts();
  if ('blockAds' in ch) syncAdBlock();
  if ('silence' in ch || 'deep' in ch) for (const [tabId, m] of modeCache) if (m === 'focus') scheduleSilence(tabId);
});

// ---------------------------------------------------------------- message hub
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.fp === 'open-options') {
    allowOwnTabsUntil = Date.now() + 4000;
    chrome.runtime.openOptionsPage();
    sendResponse({});
    return;
  }

  // From the toolbar popup (not a tab).
  if (msg.fp === 'popup') {
    runInTab(msg.tabId, msg.action).then(
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
        if (isActive(msg.mode) !== isActive(prev) || msg.mode === 'focus') applyGuard(tabId, isActive(msg.mode));
        if (msg.mode === 'focus') injectAgents(tabId);
        if (msg.mode !== 'focus') fi(tabId).main = null;
        if (msg.mode === 'off') lastThumb.delete(tabId);
        scheduleSilence(tabId);
        sendResponse({});
      })();
      return true;
    }
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
        if ((await getMode(tabId)) !== 'focus') return sendResponse({ stop: true });
        const t = fi(tabId);
        if (!t.frames.has(sender.frameId)) {
          t.frames.add(sender.frameId);
          scheduleSilence(tabId);
        }
        chrome.tabs.sendMessage(tabId, { ...msg, frameId: sender.frameId }, { frameId: 0 }).catch(() => {});
        sendResponse({});
      })();
      return true;
    case 'agent-cmd':
      chrome.tabs.sendMessage(tabId, { fp: 'agent-cmd', cmd: msg.cmd }, { frameId: msg.frameId }).catch(() => {});
      sendResponse({});
      return;
    case 'allow-next-tab':
      allowTabUntil.set(tabId, Date.now() + (msg.ms || 2500));
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
  frameInfo.delete(tabId);
  allowTabUntil.delete(tabId);
  setMode(tabId, 'off');
}
chrome.tabs.onRemoved.addListener(forget);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') forget(tabId);
});

chrome.commands.onCommand.addListener((command, tab) => {
  const map = { 'toggle-focus': 'toggle', 'toggle-lock': 'toggle-lock', 'next-player': 'next', 'reload-player': 'reload' };
  if (map[command]) run(tab, map[command]);
});
