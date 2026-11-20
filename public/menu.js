// Header hamburger menu: toggles the dropdown and marks the current page.
const btn = document.getElementById('menuBtn');
const list = document.getElementById('menuList');
if (btn && list) {
  const close = () => {
    list.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    list.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    const first = list.querySelector('a');
    if (first) first.focus();
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (list.hidden) open();
    else close();
  });
  document.addEventListener('click', (e) => {
    if (!list.hidden && !list.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !list.hidden) {
      close();
      btn.focus();
    }
  });
  list.addEventListener('click', (e) => {
    if (e.target.closest('a')) close();
  });
  const mark = () => {
    const h = location.hash || '#/';
    for (const a of list.querySelectorAll('a')) {
      const target = a.getAttribute('href');
      const on = target === '#/' ? h === '#/' || h === '' || h.startsWith('#/t/') : h.startsWith(target);
      if (on) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  };
  window.addEventListener('hashchange', mark);
  mark();
}
