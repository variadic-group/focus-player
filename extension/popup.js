// Focus Player — toolbar popup.
const $ = (id) => document.getElementById(id);
let tab = null;
let info = null;

// Automated tests open the popup in a normal tab and point it at another tab.
const forcedTab = new URLSearchParams(location.search).get('tab');

async function getTab() {
  if (forcedTab) return chrome.tabs.get(Number(forcedTab));
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}

const call = (action) => chrome.runtime.sendMessage({ fp: 'popup', tabId: tab.id, action });
const done = () => { if (!forcedTab) window.close(); };

const SITE_HINTS = {
  off: 'Only when you press Focus or Alt+Shift+F.',
  suggest: 'A small “Focus video” button appears whenever a video shows up here.',
  auto: 'Goes straight into focus when a video starts here.',
};

function render() {
  const m = info.mode;
  const s = $('status');
  s.className = '';
  if (m === 'focus') { s.textContent = info.locked ? 'Focused · kid lock on' : 'Focused · unlocked'; s.className = 'good'; }
  else if (m === 'wait') s.textContent = 'Waiting for the video…';
  else if (m === 'pick') s.textContent = 'Tap the video on the page';
  else if (m === 'suggest') { s.textContent = 'Video found · Focus button showing'; s.className = 'good'; }
  else if (m === 'armed') s.textContent = 'Watching for a video';
  else if (info.found && !info.found.ad) { s.textContent = 'Video found · ' + info.found.label; s.className = 'good'; }
  else if (info.found && info.found.ad) s.textContent = 'Only ad-like frames here so far';
  else s.textContent = 'No video on this page yet';

  const inFocus = m === 'focus' || m === 'wait' || m === 'pick';
  const p = $('primary');
  p.disabled = false;
  p.textContent = inFocus ? 'Exit focus' : info.found && !info.found.ad ? 'Focus the video' : 'Focus when it starts';
  p.classList.toggle('exit', inFocus);
  $('pick').disabled = false;
  $('sources').disabled = m !== 'focus';

  $('host').textContent = info.host || 'this site';
  document.querySelectorAll('#siteMode button').forEach((b) => b.classList.toggle('on', b.dataset.v === info.siteMode));
  $('siteHint').textContent = SITE_HINTS[info.siteMode] || '';
}

function cantRun() {
  $('status').textContent = 'Focus Player can’t run on this page';
  ['primary', 'pick', 'sources'].forEach((id) => ($(id).disabled = true));
  $('siteBox').style.display = 'none';
}

async function refresh() {
  const r = await call('info');
  if (!r || !r.ok || !r.info) return cantRun();
  info = r.info;
  render();
}

async function loadToggles() {
  const s = await chrome.storage.local.get(['blockAds', 'silence', 'autofix', 'deep']);
  const hasAll = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  $('blockAds').checked = s.blockAds !== false;
  $('silence').checked = s.silence !== false;
  $('autofix').checked = s.autofix !== false;
  $('deep').checked = !!s.deep && hasAll;
}

$('primary').addEventListener('click', async () => {
  const inFocus = ['focus', 'wait', 'pick'].includes(info.mode);
  await call(inFocus ? 'exit' : 'focus');
  done();
});
$('pick').addEventListener('click', async () => { await call('pick'); done(); });
$('sources').addEventListener('click', async () => { await call('sources'); done(); });
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

document.querySelectorAll('#siteMode button').forEach((b) =>
  b.addEventListener('click', () => {
    const v = b.dataset.v;
    const origin = info && info.origin;
    if (!origin) return;
    // The permission request must start inside the click.
    const ask = v === 'off' ? Promise.resolve(true) : chrome.permissions.request({ origins: [origin + '/*'] });
    ask.then(async (ok) => {
      if (!ok) return;
      const { siteModes = {} } = await chrome.storage.local.get('siteModes');
      if (v === 'off') delete siteModes[origin];
      else siteModes[origin] = v;
      await chrome.storage.local.set({ siteModes });
      await call('site-changed');
      refresh();
    });
  })
);

['blockAds', 'silence', 'autofix'].forEach((k) =>
  $(k).addEventListener('change', (e) => chrome.storage.local.set({ [k]: e.target.checked }))
);

$('deep').addEventListener('change', (e) => {
  if (!e.target.checked) {
    chrome.storage.local.set({ deep: false });
    return;
  }
  chrome.permissions.request({ origins: ['<all_urls>'] }).then((ok) => {
    chrome.storage.local.set({ deep: ok });
    e.target.checked = ok;
  });
});

(async () => {
  tab = await getTab();
  await loadToggles();
  if (!tab) return cantRun();
  try {
    await refresh();
  } catch (_) {
    cantRun();
  }
})();
