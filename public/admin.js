(function () {
  var csrf = (document.querySelector('meta[name=csrf]') || {}).content;
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  // Quick on/off toggles on the dashboard (saved instantly).
  $$('input[data-toggle]').forEach(function (el) {
    el.addEventListener('change', function () {
      el.disabled = true;
      fetch('/admin/profiles/' + el.dataset.toggle + '/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ key: el.dataset.key, enabled: el.checked }),
      }).then(function (r) {
        if (!r.ok) throw new Error();
        if (el.dataset.key === '_profile') el.closest('.profile').classList.toggle('off', !el.checked);
        else if (el.dataset.key === '_maintenance') { location.reload(); return; }
        else el.closest('.method').classList.toggle('is-on', el.checked);
        // refresh the phone preview so it reflects the change
        var card = el.closest('.profile');
        var frame = card && card.querySelector('.phone-thumb iframe');
        if (frame) frame.src = frame.src;
      }).catch(function () { el.checked = !el.checked; alert('Could not save. Please reload the page.'); })
        .finally(function () { el.disabled = false; });
    });
  });

  // Confirm destructive forms.
  $$('form[data-confirm]').forEach(function (f) {
    f.addEventListener('submit', function (e) { if (!confirm(f.dataset.confirm)) e.preventDefault(); });
  });

  // Settings: controller type and auth mode show only the relevant fields.
  function syncController() {
    var ct = (document.querySelector('input[name=controller_type]:checked') || {}).value || 'unifios';
    $$('[data-ctype]').forEach(function (b) { b.hidden = b.dataset.ctype !== ct; });
    var mode = ct === 'standalone' ? 'credentials' : ((document.querySelector('input[name=auth_mode]:checked') || {}).value || 'credentials');
    $$('[data-mode]').forEach(function (b) { b.hidden = b.dataset.mode !== mode; });
  }
  $$('input[name=controller_type], input[name=auth_mode]').forEach(function (r) { r.addEventListener('change', syncController); });
  if (document.querySelector('input[name=controller_type]')) syncController();

  // Settings tabs (hash-based, so links like #sso-google work).
  var tabs = $$('.settings .tab');
  if (tabs.length) {
    var showTab = function () {
      var h = location.hash.slice(1);
      var target = document.getElementById(h);
      var tab = target ? (target.classList.contains('tab') ? target : target.closest('.tab')) : null;
      if (!tab) tab = tabs[0];
      tabs.forEach(function (t) { t.hidden = t !== tab; });
      $$('#subnav a').forEach(function (a) { a.classList.toggle('on', a.getAttribute('href') === '#' + tab.id); });
      if (target && target.tagName === 'DETAILS') { target.open = true; setTimeout(function () { target.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 30); }
      else if (target && target !== tab) setTimeout(function () { target.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 30);
      else window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', showTab);
    showTab();
  }

  // Copy buttons.
  $$('.copy-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      var text = b.dataset.copy;
      var done = function () { b.classList.add('copied'); setTimeout(function () { b.classList.remove('copied'); }, 1200); };
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done);
      else { var t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); done(); }
    });
  });

  // Profile editor: reveal per-method options when switched on, show terms options, warn about unsaved changes.
  var form = document.getElementById('profile-form');
  if (form) {
    $$('.method-row', form).forEach(function (row) {
      var sw = row.querySelector('.switch input');
      if (!sw || !row.querySelector('.reveal')) return;
      var sync = function () { row.classList.toggle('off', !sw.checked); };
      sw.addEventListener('change', sync); sync();
    });
    var terms = form.querySelector('input[name=terms_enabled]');
    var termsOpts = form.querySelector('.terms-opts');
    if (terms && termsOpts) { var st = function () { termsOpts.classList.toggle('off', !terms.checked); }; terms.addEventListener('change', st); st(); }
    var color = form.querySelector('input[type=color]');
    if (color) color.addEventListener('input', function () { color.nextElementSibling.textContent = color.value; });
    var dirty = false;
    var note = document.getElementById('unsaved');
    form.addEventListener('input', function () { dirty = true; if (note) note.hidden = false; });
    form.addEventListener('change', function () { dirty = true; if (note) note.hidden = false; });
    form.addEventListener('submit', function () { dirty = false; });
    window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  }
})();

// HTTPS certificate: check DNS and verify without leaving the page.
(function () {
  var flow = document.getElementById('cert-flow');
  if (!flow) return;
  var csrf = flow.dataset.csrf;
  var post = function (url) {
    return fetch(url, { method: 'POST', headers: { 'X-CSRF-Token': csrf } }).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
    });
  };
  var resultBox = document.getElementById('dns-result');
  var checkBtn = document.getElementById('dns-check');
  var finishBtn = document.getElementById('cert-finish');
  var esc = function (t) { var d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
  function busy(btn, on, label) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = label; }
    else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
  }
  function show(html, cls) { resultBox.hidden = false; resultBox.innerHTML = html; resultBox.className = 'dns-result ' + (cls || ''); }

  if (checkBtn) checkBtn.addEventListener('click', function () {
    busy(checkBtn, true, 'Checking…');
    post('/admin/settings/tls/check').then(function (res) {
      var rows = '';
      res.results.forEach(function (r) {
        if (!r.answers.length) rows += '<div class="dns-row"><span class="status warn">No DNS servers found for this name</span></div>';
        r.answers.forEach(function (a) {
          var label = a.ok ? 'Found' : (a.error || (a.values.length ? 'Different value: ' + a.values.join(', ') : 'Not found yet'));
          rows += '<div class="dns-row ' + (a.ok ? 'ok' : '') + '"><span class="status ' + (a.ok ? 'ok' : 'warn') + '">' + esc(label) + '</span><code>' + esc(a.server) + '</code></div>';
        });
      });
      rows += res.ok ? '<p class="ok-text small"><b>All DNS servers have the record. You can verify now.</b></p>'
                     : '<p class="muted small">Not visible everywhere yet. Wait a minute and check again.</p>';
      show(rows);
      if (res.ok) delete finishBtn.dataset.unconfirmed;
    }).catch(function (e) { show('<div class="flash err slim">' + esc(e.message) + '</div>'); })
      .finally(function () { busy(checkBtn, false); });
  });

  if (finishBtn) finishBtn.addEventListener('click', function () {
    if (finishBtn.dataset.unconfirmed && !confirm("DNS hasn't been confirmed yet. If Let's Encrypt can't see the record, this request fails and you'll need to start again. Verify anyway?")) return;
    busy(finishBtn, true, 'Verifying with Let’s Encrypt… (up to a minute)');
    if (checkBtn) checkBtn.disabled = true;
    post('/admin/settings/tls/finish').then(function () {
      location.href = '/admin/settings?msg=' + encodeURIComponent('Certificate issued. HTTPS is now active, and you can remove the TXT record.') + '#certificate';
    }).catch(function (e) {
      location.href = '/admin/settings?err=' + encodeURIComponent(e.message) + '#certificate';
    });
  });
})();

// Copy multi-line text (recovery codes, sign-in details) and "use suggested password".
(function () {
  document.querySelectorAll('[data-copy-text]').forEach(function (b) {
    b.addEventListener('click', function () {
      var text = b.getAttribute('data-copy-text');
      var done = function () { var t = b.textContent; b.textContent = 'Copied ✓'; setTimeout(function () { b.textContent = t; }, 1400); };
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done);
      else { var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); done(); }
    });
  });
  document.querySelectorAll('[data-use-password]').forEach(function (b) {
    b.addEventListener('click', function () {
      var pw = b.getAttribute('data-use-password');
      ['pw-new', 'pw-confirm'].forEach(function (id) { var el = document.getElementById(id); if (el) { el.value = pw; el.type = 'text'; } });
      b.textContent = 'Filled in. Save it in your password manager';
    });
  });
  // Only one "Manage" menu open at a time; close when clicking elsewhere.
  var menus = document.querySelectorAll('details.menu');
  menus.forEach(function (m) { m.addEventListener('toggle', function () { if (m.open) menus.forEach(function (o) { if (o !== m) o.open = false; }); }); });
  document.addEventListener('click', function (e) { menus.forEach(function (m) { if (!m.contains(e.target)) m.open = false; }); });
})();

// Certificate card: switch between Automatic / Manual / Upload, show the chosen provider's fields, and follow a running job.
(function () {
  var radios = document.querySelectorAll('input[name=cmode]');
  if (!radios.length) return;
  function syncMode() {
    var m = (document.querySelector('input[name=cmode]:checked') || {}).value;
    document.querySelectorAll('[data-cpane]').forEach(function (p) { p.hidden = p.getAttribute('data-cpane') !== m; });
  }
  radios.forEach(function (r) { r.addEventListener('change', syncMode); }); syncMode();
  function syncProv() {
    var v = (document.querySelector('input[name=provider]:checked') || {}).value;
    document.querySelectorAll('[data-prov]').forEach(function (p) {
      var on = p.getAttribute('data-prov') === v;
      p.hidden = !on;
      p.querySelectorAll('input, textarea').forEach(function (i) { i.disabled = !on; });
    });
  }
  document.querySelectorAll('input[name=provider]').forEach(function (r) { r.addEventListener('change', syncProv); }); syncProv();
  document.querySelectorAll('input[name=upmode]').forEach(function (r) {
    r.addEventListener('change', function () { document.querySelectorAll('[data-upmode]').forEach(function (p) { p.hidden = p.getAttribute('data-upmode') !== r.value; }); });
  });
  var job = document.getElementById('tls-job');
  if (job && job.getAttribute('data-running') === '1') {
    var poll = setInterval(function () {
      fetch('/admin/settings/tls/job').then(function (r) { return r.json(); }).then(function (s) {
        var log = job.querySelector('.job-log');
        log.innerHTML = '';
        ((s.job && s.job.log) || []).forEach(function (l) { var li = document.createElement('li'); li.textContent = l.msg; log.appendChild(li); });
        if (!s.running) { clearInterval(poll); location.href = '/admin/settings?' + (s.job && s.job.status === 'ok' ? 'msg=' + encodeURIComponent('Certificate installed. HTTPS is active.') : 'err=' + encodeURIComponent((s.job && s.job.error) || 'Certificate request failed')) + '#certificate'; }
      }).catch(function () {});
    }, 2500);
  }
})();
