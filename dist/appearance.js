// Appearance is a browser preference; it never changes the shared ledger.
(() => {
  const key = 'yuantuo.web.appearance';
  const valid = value => ['system', 'light', 'dark'].includes(value);
  let value = 'system';
  try { const saved = localStorage.getItem(key); if (valid(saved)) value = saved; } catch {}
  const apply = next => {
    value = valid(next) ? next : 'system';
    document.documentElement.dataset.appearance = value;
    document.querySelectorAll('[data-appearance-control]').forEach(el => { el.value = value; });
  };
  apply(value);
  document.addEventListener('DOMContentLoaded', () => apply(value));
  document.addEventListener('change', event => {
    if (!event.target.matches('[data-appearance-control]')) return;
    apply(event.target.value);
    try { localStorage.setItem(key, value); } catch {}
  });
  window.addEventListener('storage', event => {
    if (event.key === key) apply(event.newValue);
  });
})();
