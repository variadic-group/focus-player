// Focus Player — toolbar popup.
const $ = (id) => document.getElementById(id);
let tab = null;
let info = null;

// Automated tests open the popup in a normal tab and point it at another tab.
const forcedTab = new URLSearchParams(location.search).get('tab');
const getTab = async () => (forcedTab ? chrome.tabs.get(Number(forcedTab)) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]);
const call = (action) => chrome.runtime.sendMessage({ fp: 'popup', tabId: tab.id, action });
const done = () => { if (!forcedTab) window.close(); };

const SITE_HINTS = {
  off: 'Only when you ask: the button above or Alt+Shift+F.',
  suggest: 'Shows a small “Theater mode” button whenever a video appears here.',
  auto: 'Goes straight into theater mode whenever a video starts here.',
};

function render() {
  const m = info.mode;
  const s = $('status');
  s.className = '';
  if (m === 'theater') { s.textContent = 'Theater mode is on'; s.className = 'good'; }
  else if (m === 'wait') s.textContent = 'Waiting for a video…';
  else if (m === 'pick') s.textContent = 'Click the video on the page';
  else if (info.found && info.found.ok) { s.textContent = info.found.label + ' found'; s.className = 'good'; }
  else if (info.hasVideo) { s.textContent = 'Video found'; s.className = 'good'; }
  else s.textContent = 'No video on this page yet';

  const on = m === 'theater' || m === 'wait' || m === 'pick';
  $('theater').disabled = false;
  $('theater').classList.toggle('on', on);
  $('theater').querySelector('span').textContent = on ? 'Exit theater mode' : 'Theater mode';
  $('pick').disabled = false;
  $('pip').disabled = !info.hasVideo;
  ['slower', 'faster', 'rate'].forEach((id) => ($(id).disabled = !info.hasVideo));
  $('rate').textContent = (info.rate || '1') + '×';

  $('host').textContent = info.host || 'this site';
  document.querySelectorAll('#siteMode button').forEach((b) => b.classList.toggle('on', b.dataset.v === info.siteMode));
  $('siteHint').textContent = SITE_HINTS[info.siteMode] || '';
  $('pickedRow').hidden = !info.picked;
  $('toolsHint').hidden = !(info.found && info.found.ok && !info.hasVideo && !$('deep').checked);
}

function cantRun() {
  $('status').textContent = 'Focus Player can’t run on this page';
  ['theater', 'pick', 'pip', 'slower', 'faster', 'rate'].forEach((id) => ($(id).disabled = true));
  $('siteBox').style.display = 'none';
}

async function refresh() {
  const r = await call('info');
  if (!r || !r.ok || !r.info) return cantRun();
  info = r.info;
  render();
}

$('theater').addEventListener('click', async () => {
  const on = ['theater', 'wait', 'pick'].includes(info.mode);
  await call(on ? 'exit' : 'theater');
  done();
});
$('pick').addEventListener('click', async () => { await call('pick'); done(); });
$('pip').addEventListener('click', async () => {
  const r = await call('pip');
  if (r && r.ok && r.info && r.info.ok) done();
  else $('status').textContent = 'Pop-out isn’t available for this video';
});
for (const [id, action] of [['slower', 'slower'], ['faster', 'faster'], ['rate', 'reset-speed']]) {
  $(id).addEventListener('click', async () => {
    const r = await call(action);
    if (r && r.ok && r.info) { info = { ...info, ...r.info }; render(); }
  });
}
$('settings').addEventListener('click', () => chrome.runtime.sendMessage({ fp: 'open-options' }));
$('shortcuts').addEventListener('click', () => chrome.runtime.sendMessage({ fp: 'open-shortcuts' }));
$('forget').addEventListener('click', async () => { await call('forget'); refresh(); });
$('diag').addEventListener('click', async () => {
  const r = await call('diag');
  const text = r && r.info && r.info.diag;
  if (!text) return;
  await navigator.clipboard.writeText(text).catch(() => {});
  $('diag').textContent = 'Copied ✓';
});

document.querySelectorAll('#siteMode button').forEach((b) =>
  b.addEventListener('click', () => {
    const v = b.dataset.v;
    const origin = info && info.origin;
    if (!origin) return;
    // The permission request has to start inside the click.
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

['blockAds', 'silence', 'recover'].forEach((k) => $(k).addEventListener('change', (e) => chrome.storage.local.set({ [k]: e.target.checked })));
$('deep').addEventListener('change', (e) => {
  if (!e.target.checked) {
    chrome.storage.local.set({ deep: false });
    return;
  }
  chrome.permissions.request({ origins: ['<all_urls>'] }).then((ok) => {
    chrome.storage.local.set({ deep: ok });
    e.target.checked = ok;
    if (ok) refresh();
  });
});

(async () => {
  tab = await getTab();
  const s = await chrome.storage.local.get(['blockAds', 'silence', 'recover', 'deep']);
  const hasAll = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  $('blockAds').checked = s.blockAds !== false;
  $('silence').checked = s.silence !== false;
  $('recover').checked = s.recover !== false;
  $('deep').checked = !!s.deep && hasAll;
  if (!tab) return cantRun();
  try {
    await refresh();
  } catch (_) {
    cantRun();
  }
})();
