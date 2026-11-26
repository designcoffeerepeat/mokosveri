// Mobile floating section menu. On narrow screens, a round button in the
// bottom right corner opens a sheet listing the sections of the current page
// (its h2 headings, or h3 headings when a page has fewer than two h2s).
// Tapping one scrolls to it. Works on every route because it watches #app
// for re-renders instead of hooking into each page.
const app = document.getElementById('app');
const mq = matchMedia('(max-width: 760px)');

if (app) {
  const btn = document.createElement('button');
  btn.className = 'snav-btn';
  btn.type = 'button';
  btn.hidden = true;
  btn.setAttribute('aria-label', 'Jump to a section');
  btn.setAttribute('aria-haspopup', 'true');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', 'snavSheet');
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="4.5" cy="6" r="1.4" fill="currentColor"/><circle cx="4.5" cy="12" r="1.4" fill="currentColor"/><circle cx="4.5" cy="18" r="1.4" fill="currentColor"/></svg><span>Sections</span>';

  const scrim = document.createElement('div');
  scrim.className = 'snav-scrim';
  scrim.hidden = true;

  const sheet = document.createElement('div');
  sheet.className = 'snav-sheet';
  sheet.id = 'snavSheet';
  sheet.hidden = true;
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Sections on this page');

  document.body.append(scrim, sheet, btn);

  let heads = [];

  const label = (h) => {
    const c = h.cloneNode(true);
    c.querySelectorAll('small, button, svg, .muted').forEach((n) => n.remove());
    return c.textContent.replace(/\s+/g, ' ').trim();
  };

  const visible = (h) => h.getClientRects().length > 0 && !h.closest('.err, [hidden]');

  const collect = () => {
    const pick = (sel) => [...app.querySelectorAll(sel)].filter(visible).filter((h) => label(h));
    let list = pick('h2');
    if (list.length < 2) list = pick('h3');
    return list.length >= 2 ? list : [];
  };

  const offset = () => {
    const top = document.querySelector('header.top');
    return (top ? top.getBoundingClientRect().height : 0) + 12;
  };

  const current = () => {
    const y = offset() + 8;
    let idx = -1;
    heads.forEach((h, i) => {
      if (h.getBoundingClientRect().top <= y) idx = i;
    });
    return idx;
  };

  const close = (focusBtn) => {
    if (sheet.hidden) return;
    sheet.hidden = true;
    scrim.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (focusBtn) btn.focus();
  };

  const open = () => {
    const cur = current();
    sheet.innerHTML = `<div class="snav-h">On this page</div><ul>${heads
      .map((h, i) => `<li><button type="button" data-i="${i}"${i === cur ? ' aria-current="true"' : ''}>${escapeHtml(label(h))}</button></li>`)
      .join('')}<li class="snav-top"><button type="button" data-i="top">Back to top</button></li></ul>`;
    sheet.hidden = false;
    scrim.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    const focus = sheet.querySelector('[aria-current]') || sheet.querySelector('button');
    if (focus) {
      focus.focus({ preventScroll: true });
      focus.scrollIntoView({ block: 'nearest' });
    }
  };

  const jump = (h) => {
    const y = h.getBoundingClientRect().top + window.scrollY - offset();
    window.scrollTo({ top: Math.max(0, y), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (sheet.hidden) open();
    else close(false);
  });
  scrim.addEventListener('click', () => close(false));
  sheet.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    const i = b.dataset.i;
    close(false);
    if (i === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
    else if (heads[+i]) jump(heads[+i]);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sheet.hidden) close(true);
  });

  const refresh = () => {
    heads = mq.matches ? collect() : [];
    btn.hidden = heads.length === 0;
    if (btn.hidden) close(false);
  };

  let timer = 0;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 150);
  };

  new MutationObserver(schedule).observe(app, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('hashchange', () => {
    close(false);
    schedule();
  });
  if (mq.addEventListener) mq.addEventListener('change', refresh);
  else mq.addListener(refresh);
  refresh();
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
