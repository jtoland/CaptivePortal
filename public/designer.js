/* global grapesjs, CP */
// Page designer: GrapesJS canvas with a simplified, task-focused UI.
//  - Left:  "Add" (labelled blocks) and "Page" (background, font, sign-in box look)
//  - Right: contextual "Edit" panel for whatever is selected, plus an "Advanced" drawer with the raw GrapesJS tools
(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var plugin = function (name) { var p = window[name]; return p && (p.default || p); };
  var statusEl = $('#d-status');
  function status(text, cls) { statusEl.textContent = text; statusEl.className = 'd-status ' + (cls || ''); }
  var api = function (url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'X-CSRF-Token': CP.csrf }, opts.body ? { 'Content-Type': 'application/json' } : {}, opts.headers || {});
    return fetch(url, opts).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r; });
  };
  var store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } } };

  // ---------- the sign-in box (real widget markup, so the canvas is WYSIWYG) ----------
  var widgetHtml = '<div style="padding:24px;text-align:center;color:#94a3b8;font:13px system-ui">Sign-in box</div>';
  var widgetReady = api('/admin/api/profiles/' + CP.profileId + '/widget').then(function (r) { return r.text(); })
    .then(function (h) { widgetHtml = h; }).catch(function () {});
  function themedWidget(accent, theme) {
    return widgetHtml.replace(/cp-theme-(light|dark)/, 'cp-theme-' + theme).replace(/--cp-accent:[^;"]*/, '--cp-accent: ' + accent);
  }
  function paintLogin(el) {
    el.innerHTML = '<div class="cp-js" style="pointer-events:none">' + themedWidget(CP.accent, CP.theme) + '</div>';
    var first = el.querySelector('.cp-panel');
    if (first) first.classList.add('active');
  }

  var loginType = function (ed) {
    ed.DomComponents.addType('portal-login', {
      isComponent: function (el) { return el && el.hasAttribute && el.hasAttribute('data-portal-login') ? { type: 'portal-login' } : false; },
      model: { defaults: { name: 'Sign-in box', tagName: 'div', droppable: false, copyable: false, attributes: { 'data-portal-login': '1', class: 'portal-login-slot' }, traits: [], components: [] } },
      view: { onRender: function () { var el = this.el; paintLogin(el); widgetReady.then(function () { paintLogin(el); }); } },
    });
  };

  // ---------- editor ----------
  var editor = grapesjs.init({
    container: '#gjs',
    height: '100%',
    fromElement: false,
    storageManager: false,
    projectData: CP.project || undefined,
    components: CP.project ? undefined : CP.html,
    style: CP.project ? undefined : CP.css,
    plugins: [loginType, plugin('grapesjs-style-bg')].filter(Boolean),
    panels: { defaults: [] },
    blockManager: { appendTo: '#d-blocks' },
    styleManager: { appendTo: '#d-adv-styles' },
    selectorManager: { appendTo: '#d-adv-selectors', componentFirst: true },
    traitManager: { appendTo: '#d-adv-traits' },
    layerManager: { appendTo: '#d-adv-layers' },
    canvas: { styles: ['/static/portal.css'] },
    // Devices only resize the preview: edits apply to every screen size (no per-device media rules),
    // which is what people expect from a simple editor. Templates keep their own responsive CSS.
    deviceManager: {
      devices: [
        { id: 'phone', name: 'Phone', width: '390px', widthMedia: '' },
        { id: 'tablet', name: 'Tablet', width: '820px', widthMedia: '' },
        { id: 'desktop', name: 'Desktop', width: '', widthMedia: '' },
      ],
    },
    assetManager: { upload: '/admin/api/upload', uploadName: 'files', headers: { 'X-CSRF-Token': CP.csrf }, autoAdd: true },
  });
  fetch('/admin/api/uploads').then(function (r) { return r.json(); }).then(function (list) { editor.AssetManager.add(list); });
  var win = function () { return editor.Canvas.getWindow(); };
  var paintAllLogins = function () { editor.getWrapper().find('[data-portal-login]').forEach(function (c) { if (c.getEl()) paintLogin(c.getEl()); }); };

  // ---------- top bar: devices, undo/redo ----------
  $$('.d-devices button').forEach(function (b) {
    b.addEventListener('click', function () {
      editor.setDevice(b.dataset.device);
      $$('.d-devices button').forEach(function (x) { x.classList.toggle('on', x === b); });
    });
  });
  var um = editor.UndoManager;
  $('#d-undo').addEventListener('click', function () { um.undo(); });
  $('#d-redo').addEventListener('click', function () { um.redo(); });
  function syncHistory() { $('#d-undo').disabled = !um.hasUndo(); $('#d-redo').disabled = !um.hasRedo(); }

  // ---------- blocks ----------
  var bm = editor.BlockManager;
  var svg = function (p) { return '<svg viewBox="0 0 24 24" style="fill:none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>'; };
  var F = 'font-family:inherit;';
  var blocks = [
    ['Sign-in', 'portal-login', 'Sign-in box', '<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M8.5 9h7M8.5 12.5h7"/><rect x="8.5" y="15.5" width="7" height="2.5" rx="1"/>', { type: 'portal-login' }],
    ['Basics', 'heading', 'Heading', '<path d="M6 5v14M18 5v14M6 12h12"/>', '<h2 style="' + F + 'font-size:26px;line-height:1.2;letter-spacing:-.02em;margin:0 0 8px">Your heading</h2>'],
    ['Basics', 'text', 'Text', '<path d="M4 6h16M4 10h16M4 14h11M4 18h7"/>', '<p style="' + F + 'font-size:15px;line-height:1.6;color:#475569;margin:0 0 16px">Write something here. Double-click to edit.</p>'],
    ['Basics', 'image', 'Image', '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>', { type: 'image', style: { display: 'block', width: '100%', height: 'auto', 'border-radius': '12px', margin: '0 0 16px' }, activate: true }],
    ['Basics', 'logo', 'Logo', '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8 12.5a5.5 5.5 0 0 1 8 0M10 15a2.6 2.6 0 0 1 4 0"/>', { type: 'image', style: { display: 'block', width: '56px', height: 'auto', margin: '0 0 20px', 'border-radius': '14px' }, activate: true }],
    ['Basics', 'button', 'Button', '<rect x="3" y="8" width="18" height="8" rx="4"/><path d="M10 12h4"/>', '<a href="#" style="' + F + 'display:inline-block;padding:12px 22px;border-radius:12px;background:' + CP.accent + ';color:#fff;font-weight:600;font-size:15px;text-decoration:none">Learn more</a>'],
    ['Basics', 'badge', 'Badge', '<rect x="3" y="8" width="18" height="8" rx="4"/><circle cx="7.5" cy="12" r="1.2"/>', '<span style="' + F + 'display:inline-block;font-size:12px;font-weight:600;letter-spacing:.04em;padding:4px 10px;border-radius:999px;background:#eef2ff;color:' + CP.accent + ';margin:0 0 12px">Guest network</span>'],
    ['Basics', 'list', 'Ticked list', '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>', '<ul style="' + F + 'list-style:none;padding:0;margin:0 0 20px;display:grid;gap:10px;color:#334155;font-size:15px"><li>✓&nbsp; Fast, free WiFi</li><li>✓&nbsp; Secure guest network</li><li>✓&nbsp; No app or sign-up needed</li></ul>'],
    ['Basics', 'divider', 'Divider', '<path d="M3 12h18"/>', '<hr style="border:0;border-top:1px solid #e2e8f0;margin:20px 0">'],
    ['Basics', 'spacer', 'Space', '<path d="M12 4v16M8.5 7.5 12 4l3.5 3.5M8.5 16.5 12 20l3.5-3.5"/>', '<div style="height:32px"></div>'],
    ['Layout', 'card', 'Card', '<rect x="4" y="5" width="16" height="14" rx="3"/>', '<div style="background:#fff;border-radius:18px;padding:24px;box-shadow:0 20px 50px -24px rgba(15,23,42,.35);margin:0 0 16px;min-height:60px"></div>'],
    ['Layout', 'columns', 'Two columns', '<rect x="3" y="5" width="8" height="14" rx="1.5"/><rect x="13" y="5" width="8" height="14" rx="1.5"/>', '<div style="display:flex;flex-wrap:wrap;gap:16px;margin:0 0 16px"><div style="flex:1 1 200px;min-height:60px;padding:8px"></div><div style="flex:1 1 200px;min-height:60px;padding:8px"></div></div>'],
    ['Layout', 'hero', 'Centred page', '<rect x="2.5" y="3.5" width="19" height="17" rx="2"/><rect x="7.5" y="7" width="9" height="10" rx="1.5"/>',
      '<section style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:40px 16px;box-sizing:border-box;background:linear-gradient(160deg,' + CP.accent + ' 0%,#0f172a 100%)">' +
      '<div style="width:100%;max-width:400px;background:#fff;border-radius:22px;padding:32px 26px;box-sizing:border-box;box-shadow:0 30px 80px -24px rgba(0,0,0,.5)">' +
      '<h1 style="' + F + 'font-size:26px;letter-spacing:-.02em;margin:0 0 8px;color:#0f172a">Welcome</h1><p style="' + F + 'color:#475569;margin:0 0 24px;line-height:1.55">Sign in to get online.</p>' +
      '<div data-portal-login="1" class="portal-login-slot"></div></div></section>'],
    ['Layout', 'split', 'Split page', '<rect x="2.5" y="3.5" width="19" height="17" rx="2"/><path d="M12 3.5v17"/>',
      '<section style="display:flex;flex-wrap:wrap;min-height:100vh"><div style="flex:1 1 320px;min-height:220px;background:#1e293b center/cover no-repeat"></div>' +
      '<div style="flex:1 1 360px;display:flex;flex-direction:column;justify-content:center;padding:40px 24px;background:#fff;box-sizing:border-box"><div style="max-width:380px;width:100%;margin:0 auto">' +
      '<h1 style="' + F + 'font-size:28px;letter-spacing:-.02em;margin:0 0 8px">Free WiFi</h1><p style="' + F + 'color:#64748b;margin:0 0 24px">Choose how you want to connect.</p>' +
      '<div data-portal-login="1" class="portal-login-slot"></div></div></div></section>'],
    ['Layout', 'footer', 'Footer', '<rect x="2.5" y="3.5" width="19" height="17" rx="2"/><path d="M2.5 16h19M8 18.3h8"/>', '<footer style="' + F + 'text-align:center;padding:20px 16px;font-size:12.5px;color:#94a3b8">© Your business · Need help? Ask a member of staff.</footer>'],
  ];
  blocks.forEach(function (b) { bm.add('cp-' + b[1], { category: b[0], label: b[2], media: svg(b[3]), content: b[4] }); });

  // ---------- left tabs ----------
  $$('[data-ltab]').forEach(function (t) {
    t.addEventListener('click', function () {
      $$('[data-ltab]').forEach(function (x) { x.classList.toggle('on', x === t); });
      $$('[data-lpane]').forEach(function (p) { p.hidden = p.dataset.lpane !== t.dataset.ltab; });
    });
  });

  // ---------- helpers ----------
  function toHex(c) {
    if (!c) return '#000000';
    if (c[0] === '#') return c.length === 4 ? '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3] : c.slice(0, 7);
    var m = c.match(/\d+(\.\d+)?/g);
    if (!m) return '#000000';
    return '#' + m.slice(0, 3).map(function (n) { return ('0' + (+n).toString(16)).slice(-2); }).join('');
  }
  function css(c) { var el = c.getEl(); return el ? win().getComputedStyle(el) : {}; }
  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : Math.round(n); }
  function set(c, props) { c.addStyle(props); }
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === 'text') el.textContent = attrs[k]; else if (k === 'html') el.innerHTML = attrs[k]; else el.setAttribute(k, attrs[k]); });
    (children || []).forEach(function (ch) { if (ch) el.appendChild(ch); });
    return el;
  }
  // UI controls ---------------------------------------------------------
  function slider(label, min, max, value, unit, onInput) {
    var out = h('output', { text: value + unit });
    var input = h('input', { type: 'range', min: min, max: max, value: value });
    input.addEventListener('input', function () { out.textContent = input.value + unit; onInput(+input.value); });
    return h('div', { class: 'd-field' }, [h('label', {}, [document.createTextNode(label), out]), input]);
  }
  function seg(label, options, current, onPick) {
    var wrap = h('div', { class: 'd-seg' });
    options.forEach(function (o) {
      var b = h('button', { type: 'button', title: o[2] || o[1], html: o[1] });
      if (o[0] === current) b.classList.add('on');
      b.addEventListener('click', function () { $$('button', wrap).forEach(function (x) { x.classList.toggle('on', x === b); }); onPick(o[0]); });
      wrap.appendChild(b);
    });
    return h('div', { class: 'd-field' }, [label ? h('div', { class: 'd-flabel', text: label }) : null, wrap]);
  }
  function colour(label, current, onPick, extra) {
    var palette = ['#0f172a', '#ffffff', '#64748b', CP.accent, '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6'];
    var picker = h('input', { type: 'color', value: toHex(current), title: 'Custom colour' });
    picker.addEventListener('input', function () { onPick(picker.value); });
    var row = h('div', { class: 'd-colors' });
    palette.forEach(function (c) {
      var b = h('button', { type: 'button', title: c, style: 'background:' + c });
      b.addEventListener('click', function () { picker.value = c; onPick(c); });
      row.appendChild(b);
    });
    row.appendChild(picker);
    if (extra) row.appendChild(extra);
    return h('div', { class: 'd-field' }, [h('div', { class: 'd-flabel', text: label }), row]);
  }
  function field(label, input) { return h('div', { class: 'd-field' }, [h('label', { text: label }), input]); }
  function button(text, cls, onClick) { var b = h('button', { type: 'button', class: 'd-btn ' + (cls || ''), html: text }); b.addEventListener('click', onClick); return b; }
  function title(text) { return h('div', { class: 'd-section-title', text: text }); }
  // Upload straight from the computer (also used for drag & drop onto the image buttons)
  var IMG_TYPES = /^image\/(png|jpe?g|gif|webp|svg\+xml)$/;
  function uploadFile(file, onSelect) {
    if (!file) return;
    if (!IMG_TYPES.test(file.type)) { status('That file type isn\'t supported. Use JPG, PNG, GIF, WebP or SVG.', 'err'); return; }
    if (file.size > 10 * 1024 * 1024) { status('That image is bigger than 10 MB.', 'err'); return; }
    var fd = new FormData();
    fd.append('files', file);
    status('Uploading ' + file.name + '…');
    fetch('/admin/api/upload', { method: 'POST', headers: { 'X-CSRF-Token': CP.csrf }, body: fd })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Upload failed'); return j; }); })
      .then(function (j) {
        var a = (j.data || [])[0];
        if (!a) throw new Error('That file type isn\'t supported. Use JPG, PNG, GIF, WebP or SVG.');
        editor.AssetManager.add({ src: a.src, name: a.name });
        onSelect(a.src);
        markDirty();
        if (dirty) status('Uploaded ' + file.name + '. Unsaved changes', 'dirty');
      })
      .catch(function (e) { status(e.message, 'err'); });
  }
  function uploadImage(onSelect) {
    var input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml' });
    input.addEventListener('change', function () { uploadFile(input.files[0], onSelect); });
    input.click();
  }
  // "Upload image" + "Choose from library", and you can also drop an image file onto them.
  function imageButtons(onSelect, uploadLabel) {
    var row = h('div', { class: 'd-imgbtns', title: 'Tip: you can also drop an image file here' }, [
      button('<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5M5 20h14"/></svg>' + (uploadLabel || 'Upload image'), 'primary', function () { uploadImage(onSelect); }),
      button('Choose from library', '', function () { pickImage(onSelect); }),
      h('small', { class: 'd-drop-hint', text: 'or drop an image here · JPG, PNG, GIF, WebP, SVG · max 10 MB' }),
    ]);
    row.addEventListener('dragover', function (e) { e.preventDefault(); row.classList.add('drag'); });
    row.addEventListener('dragleave', function () { row.classList.remove('drag'); });
    row.addEventListener('drop', function (e) { e.preventDefault(); row.classList.remove('drag'); uploadFile(e.dataTransfer.files[0], onSelect); });
    return row;
  }
  function pickImage(onSelect) {
    editor.AssetManager.open({
      types: ['image'],
      select: function (asset, complete) { onSelect(asset.getSrc()); if (complete !== false) editor.AssetManager.close(); },
    });
  }
  var I = {
    left: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h10M4 18h14"/></svg>',
    center: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M7 12h10M5 18h14"/></svg>',
    right: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M10 12h10M6 18h14"/></svg>',
  };

  // ---------- what is selected? ----------
  function kind(c) {
    if (!c) return null;
    var t = c.get('type');
    var tag = String(c.get('tagName') || '').toLowerCase();
    if (t === 'wrapper') return 'page';
    if (t === 'portal-login') return 'login';
    if (t === 'image') return 'image';
    if (t === 'link' || tag === 'a') return 'button';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (t === 'text' || t === 'textnode' || /^(p|span|li|label|small|strong|em|b)$/.test(tag)) return 'text';
    return 'box';
  }
  var KIND = {
    heading: ['Heading', 'Double-click it to change the words.', '<path d="M6 5v14M18 5v14M6 12h12"/>'],
    text: ['Text', 'Double-click it to change the words.', '<path d="M4 6h16M4 10h16M4 14h11M4 18h7"/>'],
    button: ['Button / link', 'Double-click to change the words.', '<rect x="3" y="8" width="18" height="8" rx="4"/>'],
    image: ['Image', 'Replace it with your own picture or logo.', '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>'],
    login: ['Sign-in box', 'Shows the sign-in options for this network.', '<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M8.5 9h7M8.5 12.5h7"/>'],
    box: ['Section', 'A container. Style its background, spacing and corners.', '<rect x="3" y="4" width="18" height="16" rx="2"/>'],
  };

  // ---------- edit panel ----------
  var editEl = $('#d-edit');
  function renderEdit() {
    var c = editor.getSelected();
    var k = kind(c);
    editEl.innerHTML = '';
    if (!c || k === 'page') {
      editEl.appendChild(h('div', { class: 'd-empty', html: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m4 3 14 9-6 1.5L9 20 4 3Z"/></svg><b>Click something on the page</b>Select text, an image, a button or a section to edit it here. For background and fonts, use the <i>Page</i> tab.' }));
      return;
    }
    var info = KIND[k];
    var isTop = c.parent() && c.parent().get('type') === 'wrapper';
    editEl.appendChild(h('div', { class: 'd-sel' }, [
      h('span', { class: 'd-sel-ico', html: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + info[2] + '</svg>' }),
      h('div', {}, [h('b', { text: k === 'box' && isTop ? 'Page section' : info[0] }), h('small', { text: info[1] })]),
    ]));
    var s = css(c);

    if (k === 'heading' || k === 'text') {
      editEl.appendChild(slider('Size', 10, 72, num(s.fontSize) || 16, 'px', function (v) { set(c, { 'font-size': v + 'px' }); }));
      var w = +s.fontWeight || 400;
      editEl.appendChild(seg('Weight', [['400', 'Regular'], ['500', 'Medium'], ['700', 'Bold'], ['800', 'Heavy']], String(w >= 800 ? 800 : w >= 700 ? 700 : w >= 500 ? 500 : 400), function (v) { set(c, { 'font-weight': v }); }));
      var a = s.textAlign === 'center' ? 'center' : s.textAlign === 'right' || s.textAlign === 'end' ? 'right' : 'left';
      editEl.appendChild(seg('Alignment', [['left', I.left, 'Left'], ['center', I.center, 'Centre'], ['right', I.right, 'Right']], a, function (v) { set(c, { 'text-align': v }); }));
      editEl.appendChild(colour('Colour', s.color, function (v) { set(c, { color: v }); }));
      editEl.appendChild(slider('Space below', 0, 64, num(s.marginBottom), 'px', function (v) { set(c, { 'margin-bottom': v + 'px' }); }));
    }

    if (k === 'button') {
      var href = h('input', { type: 'url', value: (c.getAttributes().href || ''), placeholder: 'https://…' });
      href.addEventListener('change', function () { c.addAttributes({ href: href.value || '#' }); });
      editEl.appendChild(field('Link address', href));
      editEl.appendChild(colour('Button colour', s.backgroundColor, function (v) { set(c, { 'background-color': v }); },
        button('None', 'sm', function () { set(c, { 'background-color': 'transparent' }); })));
      editEl.appendChild(colour('Text colour', s.color, function (v) { set(c, { color: v }); }));
      editEl.appendChild(slider('Rounded corners', 0, 30, num(s.borderTopLeftRadius), 'px', function (v) { set(c, { 'border-radius': v + 'px' }); }));
      editEl.appendChild(seg('Size', [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']], num(s.paddingTop) >= 15 ? 'l' : num(s.paddingTop) <= 8 ? 's' : 'm', function (v) {
        set(c, { padding: { s: '8px 14px', m: '12px 22px', l: '16px 30px' }[v], 'font-size': { s: '13px', m: '15px', l: '17px' }[v] });
      }));
      editEl.appendChild(seg('Width', [['auto', 'Fit text'], ['full', 'Full width']], s.display === 'block' ? 'full' : 'auto', function (v) {
        set(c, v === 'full' ? { display: 'block', 'text-align': 'center' } : { display: 'inline-block' });
      }));
    }

    if (k === 'image') {
      editEl.appendChild(h('div', { class: 'd-field' }, [h('div', { class: 'd-flabel', text: 'Picture' }), imageButtons(function (src) { c.set('src', src); }, 'Upload new image')]));
      editEl.appendChild(slider('Width', 24, 800, num(s.width) || 120, 'px', function (v) { set(c, { width: v + 'px', 'max-width': '100%', height: 'auto' }); }));
      editEl.appendChild(slider('Rounded corners', 0, 80, num(s.borderTopLeftRadius), 'px', function (v) { set(c, { 'border-radius': v + 'px' }); }));
      var ml = s.marginLeft, mr = s.marginRight;
      var pos = ml === mr && num(ml) > 0 ? 'center' : num(ml) > 0 ? 'right' : 'left';
      editEl.appendChild(seg('Position', [['left', I.left, 'Left'], ['center', I.center, 'Centre'], ['right', I.right, 'Right']], pos, function (v) {
        set(c, { display: 'block', 'margin-left': v === 'left' ? '0' : 'auto', 'margin-right': v === 'right' ? '0' : 'auto' });
      }));
      var alt = h('input', { type: 'text', value: c.getAttributes().alt || '', placeholder: 'Describe the image' });
      alt.addEventListener('change', function () { c.addAttributes({ alt: alt.value }); });
      editEl.appendChild(field('Description (for screen readers)', alt));
    }

    if (k === 'login') {
      editEl.appendChild(h('div', { class: 'd-note', html: 'This box shows the sign-in methods switched on for this network. Change which ones appear in <a href="/admin/profiles/' + CP.profileId + '">network settings</a>.' }));
      editEl.appendChild(seg('Style', [['light', 'Light'], ['dark', 'Dark']], CP.theme, function (v) { setTheme(v, true); }));
      var acc = h('input', { type: 'color', value: CP.accent });
      acc.addEventListener('input', function () { setAccent(acc.value, true); });
      editEl.appendChild(field('Button colour', acc));
      editEl.appendChild(slider('Space above', 0, 64, num(s.marginTop), 'px', function (v) { set(c, { 'margin-top': v + 'px' }); }));
    }

    if (k === 'box') {
      editEl.appendChild(colour('Background', s.backgroundColor, function (v) { set(c, { 'background-color': v, 'background-image': 'none' }); },
        button('None', 'sm', function () { set(c, { background: 'transparent' }); })));
      editEl.appendChild(h('div', { class: 'd-field' }, [h('div', { class: 'd-flabel', text: 'Background photo' }),
        imageButtons(function (src) { set(c, { background: 'url("' + src + '") center / cover no-repeat' }); }, 'Upload photo')]));
      editEl.appendChild(slider('Inner spacing', 0, 80, num(s.paddingTop), 'px', function (v) { set(c, { padding: v + 'px' }); }));
      editEl.appendChild(slider('Rounded corners', 0, 48, num(s.borderTopLeftRadius), 'px', function (v) { set(c, { 'border-radius': v + 'px' }); }));
      var mw = s.maxWidth && s.maxWidth !== 'none' ? num(s.maxWidth) : 1200;
      editEl.appendChild(slider('Maximum width', 240, 1200, mw, 'px', function (v) {
        set(c, v >= 1200 ? { 'max-width': 'none' } : { 'max-width': v + 'px', 'margin-left': 'auto', 'margin-right': 'auto', width: '100%' });
      }));
      var sh = s.boxShadow && s.boxShadow !== 'none' ? (/0px 30px/.test(s.boxShadow) ? 'strong' : 'soft') : 'none';
      editEl.appendChild(seg('Shadow', [['none', 'None'], ['soft', 'Soft'], ['strong', 'Strong']], sh, function (v) {
        set(c, { 'box-shadow': { none: 'none', soft: '0 10px 30px -12px rgba(15,23,42,.25)', strong: '0 30px 70px -20px rgba(0,0,0,.5)' }[v] });
      }));
    }

    // common actions
    editEl.appendChild(title('Arrange'));
    var parent = c.parent();
    var grid = h('div', { class: 'd-actions-grid' });
    grid.appendChild(button('↑ Move up', 'sm', function () { move(c, -1); }));
    grid.appendChild(button('↓ Move down', 'sm', function () { move(c, 1); }));
    if (k !== 'login') grid.appendChild(button('Duplicate', 'sm', function () { var cl = c.clone(); parent.append(cl, { at: c.index() + 1 }); editor.select(cl); }));
    grid.appendChild(button('Delete', 'sm danger', function () { c.remove(); editor.select(null); }));
    editEl.appendChild(grid);
    if (parent && parent.get('type') !== 'wrapper') {
      editEl.appendChild(h('div', { class: 'd-field mt' }, [button('Select the container around this', 'sm block', function () { editor.select(parent); })]));
    }
  }
  function move(c, dir) {
    var parent = c.parent();
    if (!parent) return;
    var at = c.index() + dir;
    if (at < 0 || at >= parent.components().length) return;
    c.remove({ temporary: true });
    parent.append(c, { at: at });
    editor.select(c);
  }

  // ---------- page panel: background, fonts, sign-in look ----------
  var lookDirty = false;
  var loginSelected = function () { return kind(editor.getSelected()) === 'login'; };
  function setAccent(v, fromEdit) {
    CP.accent = v; $('#d-accent').value = v; lookDirty = true; paintAllLogins(); markDirty();
    if (!fromEdit && loginSelected()) renderEdit();
  }
  function setTheme(v, fromEdit) {
    CP.theme = v; lookDirty = true; paintAllLogins(); markDirty();
    $$('#d-theme button').forEach(function (b) { b.classList.toggle('on', b.dataset.v === v); });
    if (!fromEdit && loginSelected()) renderEdit();
  }
  $('#d-accent').addEventListener('input', function (e) { setAccent(e.target.value); });
  $$('#d-theme button').forEach(function (b) { b.addEventListener('click', function () { setTheme(b.dataset.v); }); });

  function pageTarget() {
    var first = editor.getWrapper().components().at(0);
    return first && first.get('type') !== 'portal-login' ? first : editor.getWrapper();
  }
  var backgrounds = [
    'linear-gradient(135deg, #6366f1 0%, #0f172a 100%)', 'linear-gradient(135deg, #0ea5e9 0%, #1e3a8a 100%)', 'linear-gradient(135deg, #10b981 0%, #064e3b 100%)',
    'linear-gradient(135deg, #f97316 0%, #9a3412 100%)', 'linear-gradient(135deg, #ec4899 0%, #7c3aed 100%)', 'linear-gradient(160deg, #fdf2f8 0%, #e0e7ff 100%)',
    'linear-gradient(160deg, #ecfeff 0%, #f0fdf4 100%)', '#ffffff', '#f5f5f4', '#0b1120',
  ];
  backgrounds.forEach(function (bg) {
    var b = h('button', { type: 'button', style: 'background:' + bg, title: 'Use this background' });
    b.addEventListener('click', function () { pageTarget().addStyle({ background: bg }); });
    $('#d-bg-swatches').appendChild(b);
  });
  $('#d-bg-color').addEventListener('input', function (e) { pageTarget().addStyle({ background: e.target.value }); });
  $('#d-bg-image').appendChild(imageButtons(function (src) { pageTarget().addStyle({ background: 'url("' + src + '") center / cover no-repeat' }); }, 'Upload photo'));

  var FONT_SEL = 'body *:not(.cp-code)';
  var fonts = [
    ['', 'Template default', 'As designed'],
    ['-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif', 'Modern', 'Clean sans-serif'],
    ['Georgia, "Times New Roman", serif', 'Classic', 'Elegant serif'],
    ['ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", system-ui, sans-serif', 'Rounded', 'Soft & friendly'],
    ['ui-monospace, "SF Mono", Menlo, Consolas, monospace', 'Technical', 'Monospace'],
  ];
  function currentFont() {
    var r = editor.Css.getRule(FONT_SEL);
    return r ? String(r.getStyle()['font-family'] || '').replace(/\s*!important\s*$/, '') : '';
  }
  function renderFonts() {
    var cur = currentFont();
    $('#d-fonts').innerHTML = '';
    fonts.forEach(function (f) {
      var b = h('button', { type: 'button' }, [h('span', { text: f[1], style: f[0] ? 'font-family:' + f[0] : '' }), h('small', { text: f[2] })]);
      if (f[0] === cur) b.classList.add('on');
      b.addEventListener('click', function () {
        var r = editor.Css.getRule(FONT_SEL);
        if (!f[0]) { if (r) editor.Css.remove(r); } else editor.Css.setRule(FONT_SEL, { 'font-family': f[0] + ' !important' });
        renderFonts(); markDirty();
      });
      $('#d-fonts').appendChild(b);
    });
  }

  // ---------- dirty tracking + save ----------
  var dirty = false;
  var ready = false;
  function markDirty() { if (!ready) return; dirty = true; status('Unsaved changes', 'dirty'); }
  editor.on('load', function () {
    editor.setDevice('Phone');
    setTimeout(function () { ready = true; um.clear(); syncHistory(); }, 600);
    status('All changes saved');
    editor.getWrapper().find('*').forEach(nameComponent);
    renderFonts();
    renderEdit();
    if (!store.get('cp-designer-welcome')) $('#d-welcome').hidden = false;
  });
  editor.on('update', function () { markDirty(); syncHistory(); });
  // Friendly names in the canvas badge (e.g. "Heading" rather than GrapesJS's generic "Text"). Set silently, so naming
  // never counts as an edit or lands in the undo history.
  function nameComponent(c) {
    var k = kind(c);
    if (c && KIND[k] && !c.get('name')) c.set('name', k === 'box' && c.parent() && c.parent().get('type') === 'wrapper' ? 'Page section' : KIND[k][0], { silent: true });
  }
  editor.on('component:add', nameComponent);
  editor.on('component:selected component:deselected', function () { renderEdit(); });
  editor.on('undo redo', function () { syncHistory(); renderEdit(); renderFonts(); });
  $('#d-welcome-ok').addEventListener('click', function () { $('#d-welcome').hidden = true; store.set('cp-designer-welcome', '1'); });
  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  function save() {
    status('Saving…');
    var html = editor.getHtml();
    var hasSlot = /data-portal-login/.test(html);
    var jobs = [api('/admin/api/profiles/' + CP.profileId + '/design', {
      method: 'POST', body: JSON.stringify({ html: html, css: editor.getCss(), project: editor.getProjectData() }),
    })];
    if (lookDirty) jobs.push(api('/admin/api/profiles/' + CP.profileId + '/look', { method: 'POST', body: JSON.stringify({ accent: CP.accent, widget_theme: CP.theme }) }));
    return Promise.all(jobs).then(function () {
      dirty = false; lookDirty = false;
      status(hasSlot ? 'Saved' : 'Saved. Tip: add a Sign-in box, or the sign-in form floats at the bottom', hasSlot ? '' : 'dirty');
    }).catch(function (e) { status('Save failed: ' + e.message, 'err'); });
  }
  $('#d-save').addEventListener('click', save);
  document.addEventListener('keydown', function (e) { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); } });
  $('#d-preview').addEventListener('click', function (e) {
    if (dirty) { e.preventDefault(); var w = window.open('about:blank', '_blank'); save().then(function () { w.location = '/preview/' + CP.profileId; }); }
  });

  // ---------- advanced drawer ----------
  $$('[data-atab]').forEach(function (t) {
    t.addEventListener('click', function () {
      $$('[data-atab]').forEach(function (x) { x.classList.toggle('on', x === t); });
      $$('[data-apane]').forEach(function (p) { p.hidden = p.dataset.apane !== t.dataset.atab; });
    });
  });
  $('#d-code').addEventListener('click', function () { editor.runCommand('export-template'); });

  // ---------- modals ----------
  function openModal(el) { el.hidden = false; }
  function closeModal(el) { el.hidden = true; }
  $$('.d-modal').forEach(function (m) { m.addEventListener('click', function (e) { if (e.target === m || e.target.hasAttribute('data-close')) closeModal(m); }); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') $$('.d-modal').forEach(closeModal); });

  var modal = $('#d-modal');
  $('#d-import').addEventListener('click', function () { $('#d-imp-html').value = ''; $('#d-imp-css').value = ''; openModal(modal); });
  $('#d-imp-cancel').addEventListener('click', function () { closeModal(modal); });
  $('#d-imp-ok').addEventListener('click', function () {
    var html = $('#d-imp-html').value;
    var cssText = $('#d-imp-css').value;
    html = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, function (_, c) { cssText += '\n' + c; return ''; });
    var body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (body) html = body[1];
    editor.setComponents(html);
    editor.setStyle(cssText);
    closeModal(modal);
  });

  // Templates gallery with live thumbnails
  var tpl = $('#d-tpl');
  var tgrid = $('#d-tpl-grid');
  var loaded = false;
  function thumbDoc(t) {
    var w = themedWidget(t.accent, t.widget_theme);
    var html = t.html.replace(/<div data-portal-login="1"[^>]*><\/div>/, '<div class="portal-login-slot">' + w + '</div>');
    return '<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/static/portal.css"><style>' + t.css + '</style></head><body>' + html + '</body></html>';
  }
  $('#d-templates').addEventListener('click', function () {
    openModal(tpl);
    if (loaded) return;
    loaded = true;
    Promise.all([api('/admin/api/templates').then(function (r) { return r.json(); }), widgetReady]).then(function (res) {
      tgrid.innerHTML = '';
      var chips = $('#d-tpl-chips');
      var tags = ['All'].concat(res[0].map(function (t) { return t.tag || 'General'; }).filter(function (v, i, a) { return a.indexOf(v) === i; }));
      chips.innerHTML = '';
      tags.forEach(function (tag, i) {
        var c = h('button', { type: 'button', class: 'd-chip' + (i === 0 ? ' on' : ''), text: tag });
        c.addEventListener('click', function () {
          $$('.d-chip', chips).forEach(function (x) { x.classList.toggle('on', x === c); });
          $$('.d-tpl', tgrid).forEach(function (card) { card.hidden = tag !== 'All' && card.dataset.tag !== tag; });
        });
        chips.appendChild(c);
      });
      res[0].forEach(function (t) {
        var b = h('button', { type: 'button', class: 'd-tpl' });
        b.dataset.tag = t.tag || 'General';
        b.innerHTML = '<div class="d-tpl-thumb"><iframe tabindex="-1" loading="lazy"></iframe><div class="d-tpl-phone"><iframe tabindex="-1" loading="lazy"></iframe></div></div><div class="d-tpl-meta"><em class="d-tpl-tag"></em><b></b><span></span></div>';
        $('.d-tpl-tag', b).textContent = t.tag || 'General';
        $('b', b).textContent = t.name;
        $('span', b).textContent = t.description;
        var doc = thumbDoc(t);
        $$('iframe', b).forEach(function (f) { f.srcdoc = doc; });
        b.addEventListener('click', function () { applyTemplate(t); });
        tgrid.appendChild(b);
      });
    });
  });
  function applyTemplate(t) {
    if (!confirm('Replace ' + (dirty ? 'your unsaved changes' : 'this page') + ' with the ' + t.name + ' template?')) return;
    api('/admin/api/profiles/' + CP.profileId + '/template', {
      method: 'POST', body: JSON.stringify({ id: t.id, keepAccent: $('#d-keep-accent').checked }),
    }).then(function () { dirty = false; location.reload(); });
  }
})();
