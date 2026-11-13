// Focus Player — overlay UI. Runs inside the extension's own iframe, so nothing
// tapped here is ever delivered to the website underneath.
(() => {
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const IDLE_MS = 3000;
  const HOLD_MS = 1200;
  let S = {}; // latest state from the page script

  const send = (cmd, extra) => parent.postMessage({ __fp: true, cmd, ...(extra || {}) }, '*');

  // ---------- auto-hide toolbar + cursor (kid mode) ----------
  let idleTimer = null;
  let overBar = false;
  let holding = null;

  function wake() {
    body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!holding && !overBar) body.classList.add('idle');
    }, IDLE_MS);
  }

  $('bar').addEventListener('pointerenter', () => { overBar = true; wake(); });
  $('bar').addEventListener('pointerleave', () => { overBar = false; wake(); });
  document.addEventListener('pointermove', wake, { passive: true });
  $('shield').addEventListener('contextmenu', (e) => e.preventDefault());

  // Shield: in kid mode taps just wake the toolbar; in pick mode they choose the video.
  let lastHover = 0;
  $('shield').addEventListener('pointermove', (e) => {
    if (!body.classList.contains('ui-pick')) return;
    const now = performance.now();
    if (now - lastHover < 60) return;
    lastHover = now;
    send('hover', { x: e.clientX, y: e.clientY });
  });
  $('shield').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    wake();
  });
  $('shield').addEventListener('click', (e) => {
    if (body.classList.contains('ui-pick')) send('pickAt', { x: e.clientX, y: e.clientY });
  });
  $('shield').addEventListener('dblclick', () => {
    if (body.classList.contains('ui-locked')) send('fullscreen');
  });

  // ---------- simple tap buttons ----------
  document.querySelectorAll('[data-cmd]').forEach((btn) => {
    btn.addEventListener('click', () => {
      send(btn.dataset.cmd);
      wake();
    });
  });

  // ---------- press-and-hold buttons (kid-proof unlock / exit) ----------
  document.querySelectorAll('[data-hold]').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      cancelHold(false);
      try { btn.setPointerCapture(e.pointerId); } catch (_) {}
      const timer = setTimeout(() => {
        holding.done = true;
        const cmd = btn.dataset.hold;
        cancelHold(false);
        send(cmd);
      }, HOLD_MS);
      holding = { btn, timer, done: false };
      btn.classList.add('holding');
      wake();
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => btn.addEventListener(ev, () => cancelHold(true)));
    btn.addEventListener('click', (e) => e.preventDefault());
  });

  function cancelHold(hint) {
    if (!holding) return;
    const { btn, timer, done } = holding;
    clearTimeout(timer);
    btn.classList.remove('holding');
    holding = null;
    if (hint && !done) toast(`Press and hold to ${btn.dataset.verb}`);
  }

  // ---------- parent tools ----------
  $('toolsBtn').addEventListener('click', () => {
    $('menu').classList.remove('diag');
    send('menu', { open: !body.classList.contains('ui-menu') });
  });

  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

  $('diagCopy').addEventListener('click', () => copyDiag());
  $('diagClose').addEventListener('click', () => $('menu').classList.remove('diag'));

  async function copyDiag() {
    const t = $('diagText');
    try {
      await navigator.clipboard.writeText(t.value);
      $('diagMsg').textContent = 'Copied. Paste it into the chat.';
    } catch (_) {
      t.focus();
      t.select();
      try {
        document.execCommand('copy');
        $('diagMsg').textContent = 'Copied. Paste it into the chat.';
      } catch (__) {
        $('diagMsg').textContent = 'Press Ctrl+C / Cmd+C to copy';
      }
    }
  }

  // ---------- keyboard (kid mode, when the overlay has focus) ----------
  document.addEventListener('keydown', (e) => {
    if (!body.classList.contains('ui-locked')) return;
    const k = e.key.toLowerCase();
    const map = { ' ': 'play', k: 'play', m: 'mute', arrowup: 'volup', arrowdown: 'voldown', f: 'fullscreen', r: 'reload' };
    if (!map[k]) return;
    e.preventDefault();
    send(map[k]);
    wake();
  });

  // ---------- toast ----------
  let toastTimer = null;
  function toast(text) {
    if (!text) return;
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ---------- state from the page script ----------
  window.addEventListener('message', (e) => {
    if (e.source !== parent) return;
    const s = e.data;
    if (!s || s.__fp !== 'state') return;
    S = s;
    body.className = body.className.replace(/\bui-\S+/g, '').trim();
    body.classList.add('ui-' + s.ui);
    body.classList.toggle('has-controls', !!s.hasControls);
    body.classList.toggle('multi', !!s.multi);
    body.classList.toggle('remembered', !!s.remembered);
    body.classList.toggle('sources', s.ui === 'wait' && s.waitReason === 'sources');

    $('play').classList.toggle('paused', !!s.paused);
    $('play').querySelector('.lbl').textContent = s.paused ? 'Play' : 'Pause';
    $('mute').classList.toggle('muted', !!s.muted);
    $('mute').querySelector('.lbl').textContent = s.muted ? 'Muted' : 'Sound';
    $('fs').querySelector('.lbl').textContent = s.fullscreen ? 'Exit full' : 'Full screen';
    $('t-autofix').classList.toggle('on', !!s.autofix);
    $('t-silence').classList.toggle('on', !!s.silence);
    $('suggestLabel').textContent = s.suggestLabel || '';
    $('waitText').textContent = s.waitText || '';

    if (s.ui !== 'pick') $('hl').classList.remove('on');
    if ('hover' in s) {
      const h = s.hover;
      const hl = $('hl');
      if (!h) hl.classList.remove('on');
      else {
        hl.style.left = h.x + 'px';
        hl.style.top = h.y + 'px';
        hl.style.width = h.w + 'px';
        hl.style.height = h.h + 'px';
        hl.classList.toggle('ad', !!h.ad);
        hl.querySelector('span').textContent = h.label;
        hl.querySelector('span').style.top = h.y < 100 ? '6px' : '-34px';
        hl.querySelector('span').style.left = h.y < 100 ? '6px' : '-3px';
        hl.classList.add('on');
      }
    }
    if (s.diag) {
      $('diagText').value = s.diag;
      $('diagMsg').textContent = '';
      $('menu').classList.add('diag');
      copyDiag();
    }
    if (s.toast) { toast(s.toast); wake(); }
  });

  send('ready');
  wake();
})();
