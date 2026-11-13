const $ = (id) => document.getElementById(id);

async function render() {
  const s = await chrome.storage.local.get(['blockAds', 'silence', 'autofix', 'deep', 'siteModes', 'picks', 'lockStyle']);
  $('lockStyle').value = ['hold', 'tap', 'off'].includes(s.lockStyle) ? s.lockStyle : 'hold';
  const hasAll = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  $('blockAds').checked = s.blockAds !== false;
  $('silence').checked = s.silence !== false;
  $('autofix').checked = s.autofix !== false;
  $('deep').checked = !!s.deep && hasAll;

  const modes = s.siteModes || {};
  const origins = Object.keys(modes);
  $('sites').innerHTML = origins.length ? '' : '<li class="empty">None yet. Open a site and choose Button or Auto in the toolbar popup.</li>';
  for (const origin of origins) {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><select><option value="suggest">Button</option><option value="auto">Auto</option></select><button>Remove</button>';
    li.querySelector('span').textContent = origin.replace(/^https?:\/\//, '');
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

  const picks = Object.keys(s.picks || {});
  $('picks').innerHTML = picks.length ? '' : '<li class="empty">None yet</li>';
  for (const host of picks) {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><button>Forget</button>';
    li.querySelector('span').textContent = host;
    li.querySelector('button').onclick = async () => {
      const cur = (await chrome.storage.local.get('picks')).picks || {};
      delete cur[host];
      await chrome.storage.local.set({ picks: cur });
      render();
    };
    $('picks').appendChild(li);
  }
}

$('lockStyle').onchange = (e) => chrome.storage.local.set({ lockStyle: e.target.value });
['blockAds', 'silence', 'autofix'].forEach((k) => ($(k).onchange = (e) => chrome.storage.local.set({ [k]: e.target.checked })));

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

render();
