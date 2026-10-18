(function () {
  var widget = document.getElementById('cp-login');
  if (!widget) return;
  document.documentElement.classList.add('cp-js');
  var each = function (list, fn) { Array.prototype.forEach.call(list, fn); };

  // Move the widget into the designer's "Login box" slot; otherwise show it as a floating card.
  var slot = document.querySelector('[data-portal-login]');
  if (slot) { slot.innerHTML = ''; slot.appendChild(widget); }
  else widget.classList.add('cp-floating');

  // Terms dialog (works without JS through :target; with JS we avoid the page jump).
  var dialog = document.getElementById('cp-terms-text');
  if (dialog) {
    document.body.appendChild(dialog); // escape any transformed/overflow-hidden ancestors
    if (widget.classList.contains('cp-theme-dark')) dialog.classList.add('cp-theme-dark');
    dialog.style.cssText = widget.style.cssText;
    each(widget.querySelectorAll('.cp-terms-link'), function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); dialog.classList.add('cp-open'); });
    });
    var close = function (e) { if (e) e.preventDefault(); dialog.classList.remove('cp-open'); if (location.hash === '#cp-terms-text') history.replaceState(null, '', location.pathname); };
    dialog.querySelector('.cp-terms-close').addEventListener('click', close);
    dialog.addEventListener('click', function (e) { if (e.target === dialog) close(e); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  }

  // Checkbox consent gates every form; implied consent is pre-filled server-side.
  var accept = document.getElementById('cp-accept');
  var terms = document.getElementById('cp-terms');
  each(widget.querySelectorAll('form'), function (f) {
    f.addEventListener('submit', function (e) {
      if (accept) {
        if (!accept.checked) {
          e.preventDefault();
          terms.classList.remove('cp-shake'); void terms.offsetWidth; terms.classList.add('cp-shake');
          terms.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
        var h = f.querySelector('input[name=accept]');
        if (h) h.value = '1';
      }
      var b = f.querySelector('button[type=submit]');
      if (b && b.classList.contains('cp-btn')) b.classList.add('cp-loading');
      if (b) setTimeout(function () { b.disabled = true; }, 0);
    });
  });
  // Restore buttons when the page comes back from bfcache (e.g. user hits Back from an SSO provider).
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) each(widget.querySelectorAll('button[type=submit]'), function (b) { b.disabled = false; b.classList.remove('cp-loading'); });
  });

  // Tabs between voucher / password / email.
  var tabs = widget.querySelectorAll('.cp-tab');
  function show(name) {
    each(tabs, function (t) { var on = t.getAttribute('data-tab') === name; t.classList.toggle('active', on); t.setAttribute('aria-selected', on); });
    each(widget.querySelectorAll('.cp-panel'), function (p) { p.classList.toggle('active', p.getAttribute('data-panel') === name); });
  }
  each(tabs, function (t) { t.addEventListener('click', function () { show(t.getAttribute('data-tab')); }); });
  if (tabs.length) {
    var want = widget.getAttribute('data-active');
    var has = want && widget.querySelector('.cp-tab[data-tab="' + want + '"]');
    show(has ? want : tabs[0].getAttribute('data-tab'));
  }

  // Voucher input: auto-format XXXX-XXXX
  var code = document.getElementById('cp-code');
  if (code) code.addEventListener('input', function () {
    var raw = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    code.value = raw.replace(/(.{4})(?=.)/g, '$1-');
  });
})();
