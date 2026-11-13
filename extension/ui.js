// Focus Player — on-page controls. Runs inside the extension's own frame.
(() => {
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const send = (cmd, extra) => parent.postMessage({ __fp: true, cmd, ...(extra || {}) }, '*');
  const IDLE_MS = 2500;

  // ---------- the pill hides itself; hovering it (or anything new to say) brings it back ----------
  let idleTimer = null;
  let hovering = false;
  function wake(ms) {
    body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!hovering && !body.classList.contains('ui-menu') && !body.classList.contains('ui-frozen')) body.classList.add('idle');
    }, ms || IDLE_MS);
  }
  document.addEventListener('pointerenter', () => { hovering = true; wake(); });
  document.addEventListener('pointerleave', () => { hovering = false; wake(800); });
  document.addEventListener('pointermove', () => wake(), { passive: true });

  // ---------- buttons ----------
  document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => send(b.dataset.cmd)));
  $('more').addEventListener('click', () => send('menu', { open: !body.classList.contains('ui-menu') }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') send(body.classList.contains('ui-pick') ? 'pickCancel' : body.classList.contains('ui-menu') ? 'menu' : 'exit', { open: false });
  });

  // ---------- pick mode ----------
  let lastHover = 0;
  $('shield').addEventListener('pointermove', (e) => {
    const now = performance.now();
    if (now - lastHover < 60) return;
    lastHover = now;
    send('hover', { x: e.clientX, y: e.clientY });
  });
  $('shield').addEventListener('click', (e) => send('pickAt', { x: e.clientX, y: e.clientY }));

  // ---------- messages ----------
  let msgTimer = null;
  function flash(text) {
    const inPill = body.classList.contains('ui-theater') || body.classList.contains('ui-frozen') || body.classList.contains('ui-menu');
    const el = inPill ? $('msg') : $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => el.classList.remove('show'), 1700);
    wake(2600);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== parent) return;
    const s = e.data;
    if (!s || s.__fp !== 'state') return;
    body.className = body.className.replace(/\bui-\S+/g, '').trim();
    body.classList.add('ui-' + s.ui);
    body.classList.toggle('multi', !!s.multi);
    body.classList.toggle('behind', s.lag != null);
    body.classList.toggle('fullscreen', !!s.fullscreen);
    body.classList.toggle('filled', !!s.fill);
    $('speed').textContent = `${s.speed}×`;
    $('live').querySelector('span').textContent = s.lag != null ? `Go live · ${s.lag}s behind` : 'Go live';
    $('waitText').textContent = s.waitLong ? 'No video yet. Start it, or click Pick.' : 'Waiting for a video to start…';
    $('suggestLabel').textContent = s.suggestLabel || '';

    if (s.ui !== 'pick') $('hl').classList.remove('on');
    if ('hover' in s) {
      const h = s.hover;
      const hl = $('hl');
      if (!h) hl.classList.remove('on');
      else {
        Object.assign(hl.style, { left: h.x + 'px', top: h.y + 'px', width: h.w + 'px', height: h.h + 'px' });
        hl.classList.toggle('warn', !!h.warn);
        hl.querySelector('span').textContent = h.label;
        hl.classList.add('on');
      }
    }
    if (s.toast) flash(s.toast);
    else if (s.wake) wake(3000);
  });

  send('ready');
  wake(3000);
})();
