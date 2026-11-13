const $ = (id) => document.getElementById(id);
const strip = (o) => o.replace(/^https?:\/\//, '');

async function render() {
  const s = await chrome.storage.local.get(['blockAds', 'silence', 'recover', 'deep', 'siteModes', 'picks', 'speeds']);
  const hasAll = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  $('blockAds').checked = s.blockAds !== false;
  $('silence').checked = s.silence !== false;
  $('recover').checked = s.recover !== false;
  $('deep').checked = !!s.deep && hasAll;

  const modes = s.siteModes || {};
  const sites = Object.keys(modes);
  $('sites').innerHTML = sites.length ? '' : '<li class="empty">None yet. Open a site and choose Button or Always in the toolbar popup.</li>';
  for (const origin of sites) {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><select><option value="suggest">Button</option><option value="auto">Always</option></select><button>Remove</button>';
    li.querySelector('span').textContent = strip(origin);
    const sel = li.querySelector('select');
    sel.value = modes[origin];
    sel.onchange = async () => {
      const cur = (await chrome.storage.local.get('siteModes')).siteModes || {};
      cur[origin] = sel.value;
      await chrome.storage.local.set({ siteModes: cur });
    };
    li.querySelector('button').onclick = async () => {
      const cur = (await chrome.storage.local.get('siteModes')).siteModes || {};
      delete cur[origin];
      await chrome.storage.local.set({ siteModes: cur });
      chrome.permissions.remove({ origins: [origin + '/*'] }).catch(() => {});
      render();
    };
    $('sites').appendChild(li);
  }

  const rows = [
    ...Object.entries(s.speeds || {}).map(([origin, rate]) => ({ key: 'speeds', id: origin, label: `${strip(origin)} · speed ${rate}×` })),
    ...Object.keys(s.picks || {}).map((host) => ({ key: 'picks', id: host, label: `${host} · picked video` })),
  ];
  $('memory').innerHTML = rows.length ? '' : '<li class="empty">Nothing yet</li>';
  for (const r of rows) {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><button>Forget</button>';
    li.querySelector('span').textContent = r.label;
    li.querySelector('button').onclick = async () => {
      const cur = (await chrome.storage.local.get(r.key))[r.key] || {};
      delete cur[r.id];
      await chrome.storage.local.set({ [r.key]: cur });
      render();
    };
    $('memory').appendChild(li);
  }
}

['blockAds', 'silence', 'recover'].forEach((k) => ($(k).onchange = (e) => chrome.storage.local.set({ [k]: e.target.checked })));
$('deep').onchange = (e) => {
  if (!e.target.checked) {
    chrome.storage.local.set({ deep: false });
    return;
  }
  chrome.permissions.request({ origins: ['<all_urls>'] }).then((ok) => {
    chrome.storage.local.set({ deep: ok });
    render();
  });
};
$('shortcuts').onclick = () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });

render();
