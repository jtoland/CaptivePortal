// Starter page templates for the designer. Each one has a [data-portal-login] slot for the login widget.

const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

// Placeholder logo: double-click it in the designer to swap in your own.
function logo(color, bg = 'none') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="${bg === 'none' ? color : bg}"/><g fill="none" stroke="${bg === 'none' ? '#fff' : color}" stroke-width="4.5" stroke-linecap="round"><path d="M16 27a23 23 0 0 1 32 0"/><path d="M22.5 34a14 14 0 0 1 19 0"/></g><circle cx="32" cy="42" r="3.6" fill="${bg === 'none' ? '#fff' : color}"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

const templates = {
  aurora: {
    tag: 'General',
    name: 'Aurora',
    description: 'Glowing gradient with a clean card. Turns into a bottom sheet on phones.',
    widget_theme: 'light',
    accent: '#4f46e5',
    html: (o) => `<main class="aurora">
  <div class="aurora-card">
    <img class="brand-logo" src="${logo(o.accent)}" alt="Logo">
    <h1 class="headline">${o.title || 'Free WiFi for our guests'}</h1>
    <p class="lede">${o.subtitle || 'Connect in a few seconds. Enter your voucher or continue as a guest.'}</p>
    <div data-portal-login="1" class="portal-login-slot"></div>
    <p class="fineprint">Need help? Ask a member of staff.</p>
  </div>
</main>`,
    css: (o) => `body { margin: 0; background: #0b1020; font-family: ${FONT}; -webkit-font-smoothing: antialiased; }
.aurora { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 48px 16px; box-sizing: border-box;
  background: radial-gradient(55% 45% at 12% 8%, rgba(99,102,241,.65) 0%, rgba(99,102,241,0) 70%), radial-gradient(45% 40% at 90% 15%, rgba(236,72,153,.45) 0%, rgba(236,72,153,0) 70%), radial-gradient(60% 55% at 50% 105%, rgba(14,165,233,.55) 0%, rgba(14,165,233,0) 70%), #0b1020; }
.aurora-card { width: 100%; max-width: 400px; background: #ffffff; border-radius: 24px; padding: 36px 28px 28px; box-sizing: border-box;
  box-shadow: 0 40px 100px -30px rgba(0,0,0,.6); }
.brand-logo { display: block; width: 52px; height: 52px; margin: 0 0 22px; border-radius: 14px; }
.headline { font-size: 26px; line-height: 1.2; letter-spacing: -0.02em; font-weight: 700; color: #0f172a; margin: 0 0 8px; }
.lede { font-size: 15px; line-height: 1.55; color: #475569; margin: 0 0 26px; }
.fineprint { font-size: 12.5px; color: #94a3b8; margin: 22px 0 0; text-align: center; }
@media (max-width: 480px) {
  .aurora { padding: 96px 0 0; align-items: flex-end; }
  .aurora-card { max-width: none; border-radius: 26px 26px 0 0; padding: 30px 20px 28px; }
}`,
  },

  lobby: {
    tag: 'Hotel & venue',
    name: 'Lobby',
    description: 'Split layout: a brand panel with selling points next to the sign-in form.',
    widget_theme: 'light',
    accent: '#0f766e',
    html: (o) => `<main class="lobby">
  <section class="lobby-brand">
    <img class="lobby-logo" src="${logo('#ffffff', 'rgba(255,255,255,0.14)')}" alt="Logo">
    <h1 class="lobby-title">${o.title || 'Stay connected while you’re with us.'}</h1>
    <ul class="lobby-points">
      <li>Fast, reliable WiFi throughout the building</li>
      <li>Secure guest network, separate from staff</li>
      <li>Connect up to your session time, no app needed</li>
    </ul>
  </section>
  <section class="lobby-form">
    <div class="lobby-inner">
      <h2 class="lobby-h2">Get online</h2>
      <p class="lobby-lede">${o.subtitle || 'Choose how you’d like to connect.'}</p>
      <div data-portal-login="1" class="portal-login-slot"></div>
      <p class="lobby-help">Trouble connecting? Ask at reception.</p>
    </div>
  </section>
</main>`,
    css: (o) => `body { margin: 0; background: #ffffff; font-family: ${FONT}; -webkit-font-smoothing: antialiased; }
.lobby { min-height: 100vh; display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); }
.lobby-brand { position: relative; padding: 56px 56px 48px; color: #ffffff; display: flex; flex-direction: column; justify-content: flex-end; gap: 0;
  background: linear-gradient(160deg, ${o.accent} 0%, #052e2b 100%); overflow: hidden; }
.lobby-brand::after { content: ""; position: absolute; width: 520px; height: 520px; right: -180px; top: -160px; border-radius: 50%;
  border: 70px solid rgba(255,255,255,0.06); }
.lobby-logo { width: 56px; height: 56px; position: absolute; top: 48px; left: 56px; border-radius: 16px; }
.lobby-title { font-size: 40px; line-height: 1.1; letter-spacing: -0.025em; font-weight: 700; margin: 0 0 28px; max-width: 520px; }
.lobby-points { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; font-size: 15.5px; color: rgba(255,255,255,0.86); }
.lobby-points li { padding-left: 30px; position: relative; line-height: 1.45; }
.lobby-points li::before { content: "✓"; position: absolute; left: 0; top: 0; width: 20px; height: 20px; border-radius: 50%;
  background: rgba(255,255,255,0.16); font-size: 12px; line-height: 20px; text-align: center; font-weight: 700; }
.lobby-form { display: flex; align-items: center; justify-content: center; padding: 48px 24px; }
.lobby-inner { width: 100%; max-width: 380px; }
.lobby-h2 { font-size: 24px; letter-spacing: -0.02em; margin: 0 0 6px; color: #0f172a; }
.lobby-lede { font-size: 15px; color: #64748b; margin: 0 0 24px; line-height: 1.5; }
.lobby-help { font-size: 12.5px; color: #94a3b8; margin: 24px 0 0; }
@media (max-width: 820px) {
  .lobby { grid-template-columns: 1fr; }
  .lobby-brand { padding: 104px 24px 28px; }
  .lobby-logo { top: 28px; left: 24px; width: 48px; height: 48px; }
  .lobby-title { font-size: 28px; margin: 0; }
  .lobby-points { display: none; }
  .lobby-form { align-items: flex-start; padding: 28px 20px 40px; }
}`,
  },

  paper: {
    tag: 'Café & boutique',
    name: 'Paper',
    description: 'Quiet, editorial and typographic. Suits cafés, boutiques and studios.',
    widget_theme: 'light',
    accent: '#b45309',
    html: (o) => `<main class="paper">
  <div class="paper-col">
    <div class="paper-top">
      <img class="paper-logo" src="${logo(o.accent)}" alt="Logo">
      <span class="paper-tag">Guest WiFi</span>
    </div>
    <h1 class="paper-title">${o.title || 'Hello. You’re nearly online.'}</h1>
    <p class="paper-lede">${o.subtitle || 'Pop in your code below, or simply continue. Enjoy your visit.'}</p>
    <div data-portal-login="1" class="portal-login-slot"></div>
    <hr class="paper-rule">
    <p class="paper-foot">Open daily · Ask us for the menu, the code, or a recommendation.</p>
  </div>
</main>`,
    css: (o) => `body { margin: 0; background: #faf8f5; font-family: ${FONT}; color: #1c1917; -webkit-font-smoothing: antialiased; }
.paper { min-height: 100vh; display: flex; justify-content: center; padding: 64px 20px; box-sizing: border-box; }
.paper-col { width: 100%; max-width: 420px; }
.paper-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 56px; }
.paper-logo { width: 40px; height: 40px; border-radius: 11px; }
.paper-tag { font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: #78716c; }
.paper-title { font-family: Georgia, "Times New Roman", serif; font-weight: 400; font-size: 40px; line-height: 1.1; letter-spacing: -0.015em; margin: 0 0 14px; }
.paper-lede { font-size: 16px; line-height: 1.6; color: #57534e; margin: 0 0 32px; }
.paper-rule { border: 0; border-top: 1px solid #e7e5e4; margin: 36px 0 16px; }
.paper-foot { font-size: 13px; color: #a8a29e; margin: 0; line-height: 1.5; }
@media (max-width: 480px) { .paper { padding: 32px 20px; } .paper-top { margin-bottom: 36px; } .paper-title { font-size: 32px; } }`,
  },

  night: {
    tag: 'Staff & corporate',
    name: 'Night',
    description: 'Dark and understated, with a dot grid. Good for staff or corporate networks.',
    widget_theme: 'dark',
    accent: '#10b981',
    html: (o) => `<main class="night">
  <div class="night-card">
    <div class="night-head">
      <img class="night-logo" src="${logo(o.accent, '#0b1220')}" alt="Logo">
      <span class="night-badge">Staff network</span>
    </div>
    <h1 class="night-title">${o.title || 'Sign in to the staff network'}</h1>
    <p class="night-lede">${o.subtitle || 'Use your work account to connect. Activity on this network may be monitored.'}</p>
    <div data-portal-login="1" class="portal-login-slot"></div>
  </div>
  <p class="night-foot">IT support: ask the service desk</p>
</main>`,
    css: (o) => `body { margin: 0; background: #05070c; font-family: ${FONT}; color: #e5e7eb; -webkit-font-smoothing: antialiased; }
.night { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 48px 16px; box-sizing: border-box;
  background-color: #05070c; background-image: radial-gradient(rgba(148,163,184,0.16) 1px, transparent 1px), radial-gradient(70% 50% at 50% 0%, rgba(16,185,129,0.16) 0%, rgba(16,185,129,0) 70%);
  background-size: 22px 22px, 100% 100%; }
.night-card { width: 100%; max-width: 400px; background: #0b1220; border: 1px solid #1e293b; border-radius: 20px; padding: 30px 26px 26px; box-sizing: border-box;
  box-shadow: 0 30px 80px -30px rgba(0,0,0,.8); }
.night-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 26px; }
.night-logo { width: 44px; height: 44px; border-radius: 12px; border: 1px solid #1e293b; }
.night-badge { font-size: 11.5px; font-weight: 600; letter-spacing: .04em; color: ${o.accent}; background: rgba(16,185,129,0.1); border: 1px solid rgba(16,185,129,0.25); padding: 4px 10px; border-radius: 999px; }
.night-title { font-size: 22px; line-height: 1.25; letter-spacing: -0.015em; font-weight: 650; margin: 0 0 8px; color: #f8fafc; }
.night-lede { font-size: 14.5px; line-height: 1.55; color: #94a3b8; margin: 0 0 24px; }
.night-foot { font-size: 12.5px; color: #475569; margin: 20px 0 0; }
@media (max-width: 480px) { .night { justify-content: flex-start; padding-top: 32px; } .night-card { padding: 24px 20px 20px; } }`,
  },
  coastal: {
    tag: 'Hotel & resort',
    name: 'Coastal',
    description: 'Sand and sea tones with a soft wave. Calm and welcoming for hotels, spas and holiday parks.',
    widget_theme: 'light',
    accent: '#0e7490',
    html: (o) => `<main class="coastal">
  <div class="coastal-sky"></div>
  <div class="coastal-card">
    <img class="coastal-logo" src="${logo(o.accent)}" alt="Logo">
    <h1 class="coastal-title">${o.title || 'Welcome, relax and connect'}</h1>
    <p class="coastal-lede">${o.subtitle || 'Complimentary WiFi for our guests, throughout the property.'}</p>
    <div data-portal-login="1" class="portal-login-slot"></div>
    <p class="coastal-foot">Reception is open 24 hours if you need anything.</p>
  </div>
</main>`,
    css: (o) => `body { margin: 0; background: #f6efe4; font-family: ${FONT}; -webkit-font-smoothing: antialiased; }
.coastal { position: relative; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 48px 16px; box-sizing: border-box; overflow: hidden;
  background: linear-gradient(180deg, #cfeef3 0%, #e8f6f4 45%, #f6efe4 46%, #f6efe4 100%); }
.coastal-sky { position: absolute; left: -10%; right: -10%; top: 38%; height: 120px; border-radius: 50%; background: ${o.accent}; opacity: .18; }
.coastal-card { position: relative; width: 100%; max-width: 410px; background: #fffdf9; border-radius: 28px; padding: 34px 28px 26px; box-sizing: border-box;
  box-shadow: 0 30px 70px -30px rgba(14,116,144,.45); border: 1px solid #efe3d1; }
.coastal-logo { display: block; width: 52px; height: 52px; border-radius: 50%; margin: 0 auto 18px; }
.coastal-title { font-family: Georgia, "Times New Roman", serif; font-weight: 400; font-size: 30px; line-height: 1.15; text-align: center; color: #12343b; margin: 0 0 10px; }
.coastal-lede { font-size: 15px; line-height: 1.55; color: #5b6b6e; text-align: center; margin: 0 0 26px; }
.coastal-foot { font-size: 12.5px; color: #9aa6a6; text-align: center; margin: 22px 0 0; }
@media (max-width: 480px) { .coastal { padding: 28px 14px; } .coastal-card { padding: 28px 20px 22px; } .coastal-title { font-size: 26px; } }`,
  },

  bistro: {
    tag: 'Restaurant & bar',
    name: 'Bistro',
    description: 'Warm, dark and a little classy, with a cream menu card. For restaurants, pubs and wine bars.',
    widget_theme: 'light',
    accent: '#9a3412',
    html: (o) => `<main class="bistro">
  <div class="bistro-card">
    <div class="bistro-top"><span class="bistro-rule"></span><img class="bistro-logo" src="${logo(o.accent, '#fbf6ee')}" alt="Logo"><span class="bistro-rule"></span></div>
    <p class="bistro-kicker">Est. 2024 · Guest WiFi</p>
    <h1 class="bistro-title">${o.title || 'Good food, good company, good WiFi.'}</h1>
    <p class="bistro-lede">${o.subtitle || 'Connect below, and ask your server about today’s specials.'}</p>
    <div data-portal-login="1" class="portal-login-slot"></div>
  </div>
</main>`,
    css: (o) => `body { margin: 0; background: #1c1410; font-family: ${FONT}; -webkit-font-smoothing: antialiased; }
.bistro { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 40px 16px; box-sizing: border-box;
  background: radial-gradient(70% 60% at 50% 0%, rgba(154,52,18,.45) 0%, rgba(28,20,16,0) 70%), #1c1410; }
.bistro-card { width: 100%; max-width: 410px; background: #fbf6ee; border-radius: 6px; padding: 30px 28px; box-sizing: border-box;
  outline: 1px solid #e8dcc8; outline-offset: -10px; box-shadow: 0 40px 80px -30px rgba(0,0,0,.7); }
.bistro-top { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
.bistro-rule { flex: 1; height: 1px; background: #d9c7aa; }
.bistro-logo { width: 46px; height: 46px; border-radius: 50%; border: 1px solid #d9c7aa; }
.bistro-kicker { text-align: center; font-size: 11px; letter-spacing: .22em; text-transform: uppercase; color: #a1866a; margin: 0 0 10px; }
.bistro-title { font-family: Georgia, "Times New Roman", serif; font-style: italic; font-weight: 400; font-size: 28px; line-height: 1.2; text-align: center; color: #2b1d14; margin: 0 0 10px; }
.bistro-lede { font-size: 14.5px; line-height: 1.55; color: #6f5b49; text-align: center; margin: 0 0 24px; }
@media (max-width: 480px) { .bistro-card { padding: 26px 20px; } .bistro-title { font-size: 25px; } }`,
  },

  corporate: {
    tag: 'Staff & corporate',
    name: 'Corporate',
    description: 'Clean and businesslike, with a header bar and an acceptable-use summary next to the form.',
    widget_theme: 'light',
    accent: '#1d4ed8',
    html: (o) => `<main class="corp">
  <header class="corp-bar"><img class="corp-logo" src="${logo(o.accent)}" alt="Logo"><span class="corp-name">Your Company</span><span class="corp-tag">Secure network</span></header>
  <div class="corp-body">
    <section class="corp-info">
      <h1 class="corp-title">${o.title || 'Connect to the company network'}</h1>
      <p class="corp-lede">${o.subtitle || 'Sign in with your work account to get online.'}</p>
      <ul class="corp-list">
        <li><b>Work accounts only.</b> Personal accounts will be declined.</li>
        <li><b>Acceptable use applies.</b> Traffic may be logged for security.</li>
        <li><b>Need help?</b> Contact the IT service desk.</li>
      </ul>
    </section>
    <section class="corp-form"><div data-portal-login="1" class="portal-login-slot"></div></section>
  </div>
</main>`,
    css: (o) => `body { margin: 0; background: #f4f6fa; font-family: ${FONT}; color: #0f172a; -webkit-font-smoothing: antialiased; }
.corp { min-height: 100vh; display: flex; flex-direction: column; }
.corp-bar { display: flex; align-items: center; gap: 12px; padding: 14px 28px; background: #ffffff; border-bottom: 1px solid #e2e8f0; }
.corp-logo { width: 32px; height: 32px; border-radius: 9px; }
.corp-name { font-weight: 700; font-size: 15px; }
.corp-tag { margin-left: auto; font-size: 12px; font-weight: 600; color: ${o.accent}; background: #eff4ff; padding: 4px 10px; border-radius: 999px; }
.corp-body { flex: 1; width: 100%; max-width: 980px; margin: 0 auto; display: grid; grid-template-columns: 1fr 400px; gap: 48px; align-items: center; padding: 56px 28px; box-sizing: border-box; }
.corp-title { font-size: 32px; line-height: 1.15; letter-spacing: -0.02em; margin: 0 0 10px; }
.corp-lede { font-size: 16px; color: #475569; margin: 0 0 26px; line-height: 1.5; }
.corp-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 14px; }
.corp-list li { padding: 14px 16px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; font-size: 14px; color: #475569; line-height: 1.5; }
.corp-list b { color: #0f172a; }
.corp-form { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 18px; padding: 28px 24px; box-shadow: 0 20px 50px -30px rgba(15,23,42,.3); }
@media (max-width: 860px) {
  .corp-body { grid-template-columns: 1fr; gap: 24px; padding: 28px 16px; }
  .corp-list { display: none; }
  .corp-title { font-size: 26px; }
  .corp-bar { padding: 12px 16px; }
}`,
  },

  neon: {
    tag: 'Events & nightlife',
    name: 'Neon',
    description: 'Black with glowing pink and cyan edges. For bars, clubs, gaming lounges and events.',
    widget_theme: 'dark',
    accent: '#ec4899',
    html: (o) => `<main class="neon">
  <div class="neon-frame">
    <div class="neon-card">
      <p class="neon-kicker">● LIVE · FREE WIFI</p>
      <h1 class="neon-title">${o.title || 'Get online. Get loud.'}</h1>
      <p class="neon-lede">${o.subtitle || 'Connect in seconds and share the night.'}</p>
      <div data-portal-login="1" class="portal-login-slot"></div>
    </div>
  </div>
</main>`,
    css: (o) => `body { margin: 0; background: #050505; font-family: ${FONT}; -webkit-font-smoothing: antialiased; }
.neon { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 40px 16px; box-sizing: border-box;
  background: radial-gradient(40% 35% at 15% 20%, rgba(236,72,153,.25) 0%, rgba(5,5,5,0) 70%), radial-gradient(40% 35% at 85% 80%, rgba(34,211,238,.22) 0%, rgba(5,5,5,0) 70%), #050505; }
.neon-frame { width: 100%; max-width: 410px; padding: 2px; border-radius: 22px; background: linear-gradient(135deg, #ec4899, #8b5cf6 50%, #22d3ee);
  box-shadow: 0 0 40px rgba(236,72,153,.35), 0 0 80px rgba(34,211,238,.18); }
.neon-card { background: #0a0a0f; border-radius: 20px; padding: 30px 26px; }
.neon-kicker { font-size: 11px; font-weight: 700; letter-spacing: .2em; color: #22d3ee; margin: 0 0 12px; }
.neon-title { font-size: 32px; line-height: 1.05; letter-spacing: -0.03em; font-weight: 800; margin: 0 0 10px; color: #ffffff; text-shadow: 0 0 24px rgba(236,72,153,.6); }
.neon-lede { font-size: 15px; color: #a1a1aa; margin: 0 0 24px; line-height: 1.5; }
@media (max-width: 480px) { .neon-card { padding: 26px 20px; } .neon-title { font-size: 28px; } }`,
  },

  mono: {
    tag: 'Studio & creative',
    name: 'Mono',
    description: 'Bold black and white with thick borders and big type. For design studios, galleries and shops.',
    widget_theme: 'light',
    accent: '#111111',
    html: (o) => `<main class="mono">
  <div class="mono-box">
    <div class="mono-head"><span>WIFI</span><span>→</span></div>
    <h1 class="mono-title">${o.title || 'Say hello to the internet.'}</h1>
    <p class="mono-lede">${o.subtitle || 'Free for visitors. Be nice.'}</p>
    <div data-portal-login="1" class="portal-login-slot"></div>
  </div>
</main>`,
    css: (o) => `body { margin: 0; background: #f2f2f0; font-family: ${FONT}; color: #111111; -webkit-font-smoothing: antialiased; }
.mono { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 40px 16px; box-sizing: border-box; }
.mono-box { width: 100%; max-width: 420px; background: #ffffff; border: 3px solid #111111; box-shadow: 10px 10px 0 #111111; padding: 0 26px 26px; box-sizing: border-box; }
.mono-head { display: flex; justify-content: space-between; margin: 0 -26px 22px; padding: 12px 26px; border-bottom: 3px solid #111111; font-weight: 800; letter-spacing: .14em; font-size: 13px; }
.mono-title { font-size: 40px; line-height: .98; letter-spacing: -0.04em; font-weight: 900; margin: 0 0 12px; text-transform: uppercase; }
.mono-lede { font-size: 15px; margin: 0 0 24px; color: #444444; }
.mono .cp-btn-primary { border-radius: 0; box-shadow: none; }
.mono .cp-input, .mono .cp-btn-sso, .mono .cp-tabs, .mono .cp-tab { border-radius: 0; }
@media (max-width: 480px) { .mono-box { box-shadow: 6px 6px 0 #111111; } .mono-title { font-size: 32px; } }`,
  },

  clinic: {
    tag: 'Healthcare',
    name: 'Clinic',
    description: 'Soft mint, rounded and reassuring, with a polite reminder. For surgeries, clinics and waiting rooms.',
    widget_theme: 'light',
    accent: '#0f766e',
    html: (o) => `<main class="clinic">
  <div class="clinic-card">
    <div class="clinic-badge"><img src="${logo(o.accent)}" alt="Logo"><span>Patient &amp; visitor WiFi</span></div>
    <h1 class="clinic-title">${o.title || 'Stay connected while you wait'}</h1>
    <p class="clinic-lede">${o.subtitle || 'Free WiFi for patients and visitors.'}</p>
    <div data-portal-login="1" class="portal-login-slot"></div>
    <p class="clinic-note">Please keep calls quiet and set your phone to silent in treatment areas. Thank you.</p>
  </div>
</main>`,
    css: (o) => `body { margin: 0; background: #ecf7f4; font-family: ${FONT}; color: #134e4a; -webkit-font-smoothing: antialiased; }
.clinic { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 40px 16px; box-sizing: border-box;
  background: radial-gradient(50% 40% at 100% 0%, #d1f0e8 0%, rgba(236,247,244,0) 70%), radial-gradient(45% 40% at 0% 100%, #dcefff 0%, rgba(236,247,244,0) 70%), #ecf7f4; }
.clinic-card { width: 100%; max-width: 410px; background: #ffffff; border-radius: 26px; padding: 28px 26px 24px; box-sizing: border-box; box-shadow: 0 24px 60px -30px rgba(15,118,110,.35); }
.clinic-badge { display: inline-flex; align-items: center; gap: 10px; background: #f0faf7; border-radius: 999px; padding: 6px 14px 6px 6px; margin-bottom: 20px; font-size: 13px; font-weight: 600; color: ${o.accent}; }
.clinic-badge img { width: 30px; height: 30px; border-radius: 50%; }
.clinic-title { font-size: 25px; line-height: 1.2; letter-spacing: -0.015em; margin: 0 0 8px; color: #0b3b38; }
.clinic-lede { font-size: 15px; color: #4b7471; margin: 0 0 24px; line-height: 1.5; }
.clinic-note { font-size: 12.5px; line-height: 1.5; color: #6b8e8a; background: #f6fbfa; border-radius: 14px; padding: 12px 14px; margin: 22px 0 0; }
@media (max-width: 480px) { .clinic-card { padding: 24px 20px 20px; } }`,
  },

  campus: {
    tag: 'Education & coworking',
    name: 'Campus',
    description: 'Bright yellow header on a notebook grid. For schools, libraries, colleges and coworking spaces.',
    widget_theme: 'light',
    accent: '#1e293b',
    html: (o) => `<main class="campus">
  <div class="campus-card">
    <div class="campus-head">
      <img class="campus-logo" src="${logo('#1e293b', '#facc15')}" alt="Logo">
      <h1 class="campus-title">${o.title || 'Hello, bright minds.'}</h1>
      <p class="campus-lede">${o.subtitle || 'Sign in to the campus WiFi.'}</p>
    </div>
    <div class="campus-body"><div data-portal-login="1" class="portal-login-slot"></div></div>
  </div>
</main>`,
    css: (o) => `body { margin: 0; background: #f8fafc; font-family: ${FONT}; color: #1e293b; -webkit-font-smoothing: antialiased; }
.campus { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 40px 16px; box-sizing: border-box;
  background-color: #f8fafc; background-image: linear-gradient(rgba(30,41,59,.06) 1px, transparent 1px), linear-gradient(90deg, rgba(30,41,59,.06) 1px, transparent 1px); background-size: 26px 26px; }
.campus-card { width: 100%; max-width: 410px; background: #ffffff; border-radius: 20px; overflow: hidden; border: 2px solid #1e293b; box-shadow: 0 8px 0 #1e293b; }
.campus-head { background: #facc15; padding: 26px 24px 22px; border-bottom: 2px solid #1e293b; }
.campus-logo { width: 46px; height: 46px; border-radius: 12px; border: 2px solid #1e293b; margin-bottom: 14px; }
.campus-title { font-size: 28px; line-height: 1.1; letter-spacing: -0.02em; font-weight: 800; margin: 0 0 6px; }
.campus-lede { font-size: 15px; margin: 0; color: #3f3a1a; }
.campus-body { padding: 24px; }
@media (max-width: 480px) { .campus-head { padding: 22px 20px 18px; } .campus-body { padding: 20px; } .campus-title { font-size: 25px; } }`,
  },

  glass: {
    tag: 'General',
    name: 'Glass',
    description: 'Frosted-glass card floating over colourful blobs. Modern and eye-catching.',
    widget_theme: 'light',
    accent: '#7c3aed',
    html: (o) => `<main class="glass">
  <span class="glass-blob glass-b1"></span><span class="glass-blob glass-b2"></span><span class="glass-blob glass-b3"></span>
  <div class="glass-card">
    <img class="glass-logo" src="${logo(o.accent)}" alt="Logo">
    <h1 class="glass-title">${o.title || 'You’re one tap away'}</h1>
    <p class="glass-lede">${o.subtitle || 'Sign in below to start browsing.'}</p>
    <div data-portal-login="1" class="portal-login-slot"></div>
  </div>
</main>`,
    css: (o) => `body { margin: 0; background: #eef0ff; font-family: ${FONT}; -webkit-font-smoothing: antialiased; }
.glass { position: relative; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 40px 16px; box-sizing: border-box; overflow: hidden; background: #eef0ff; }
.glass-blob { position: absolute; border-radius: 50%; filter: blur(50px); opacity: .75; }
.glass-b1 { width: 360px; height: 360px; background: #a78bfa; top: -80px; left: -60px; }
.glass-b2 { width: 320px; height: 320px; background: #f472b6; bottom: -90px; right: -40px; }
.glass-b3 { width: 260px; height: 260px; background: #38bdf8; top: 40%; left: 55%; }
.glass-card { position: relative; width: 100%; max-width: 400px; background: rgba(255,255,255,.72); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
  border: 1px solid rgba(255,255,255,.8); border-radius: 26px; padding: 32px 26px 26px; box-sizing: border-box; box-shadow: 0 30px 70px -30px rgba(76,29,149,.4); }
.glass-logo { display: block; width: 50px; height: 50px; border-radius: 14px; margin: 0 0 20px; }
.glass-title { font-size: 27px; line-height: 1.15; letter-spacing: -0.02em; font-weight: 750; color: #1e1b4b; margin: 0 0 8px; }
.glass-lede { font-size: 15px; color: #4c4f6b; margin: 0 0 24px; line-height: 1.5; }
@media (max-width: 480px) { .glass-card { padding: 26px 20px 20px; } }`,
  },

  retail: {
    tag: 'Retail & shopping',
    name: 'Retail',
    description: 'Bright coral with a promo banner to reward sign-ups. For shops, malls and showrooms.',
    widget_theme: 'light',
    accent: '#e11d48',
    html: (o) => `<main class="retail">
  <div class="retail-promo">Sign up today and get <b>10% off</b> your next purchase</div>
  <div class="retail-wrap">
    <div class="retail-card">
      <img class="retail-logo" src="${logo(o.accent)}" alt="Logo">
      <h1 class="retail-title">${o.title || 'Free WiFi while you shop'}</h1>
      <p class="retail-lede">${o.subtitle || 'Join our list for exclusive offers, or just connect.'}</p>
      <div data-portal-login="1" class="portal-login-slot"></div>
      <p class="retail-foot">Offer terms apply. Ask in store for details.</p>
    </div>
  </div>
</main>`,
    css: (o) => `body { margin: 0; background: #fff1f2; font-family: ${FONT}; color: #1f1720; -webkit-font-smoothing: antialiased; }
.retail { min-height: 100vh; display: flex; flex-direction: column; background: linear-gradient(160deg, #fff1f2 0%, #ffe4e6 100%); }
.retail-promo { background: ${o.accent}; color: #ffffff; text-align: center; font-size: 14px; padding: 11px 16px; letter-spacing: .01em; }
.retail-promo b { font-weight: 800; }
.retail-wrap { flex: 1; display: flex; align-items: center; justify-content: center; padding: 36px 16px; }
.retail-card { width: 100%; max-width: 410px; background: #ffffff; border-radius: 22px; padding: 30px 26px 24px; box-sizing: border-box; box-shadow: 0 24px 60px -28px rgba(225,29,72,.45); }
.retail-logo { display: block; width: 50px; height: 50px; border-radius: 14px; margin: 0 0 18px; }
.retail-title { font-size: 27px; line-height: 1.15; letter-spacing: -0.02em; font-weight: 800; margin: 0 0 8px; }
.retail-lede { font-size: 15px; color: #6b5a60; margin: 0 0 24px; line-height: 1.5; }
.retail-foot { font-size: 12px; color: #a8939a; margin: 20px 0 0; text-align: center; }
@media (max-width: 480px) { .retail-card { padding: 26px 20px 20px; } .retail-promo { font-size: 13px; } }`,
  },

  pulse: {
    tag: 'Gym & sport',
    name: 'Pulse',
    description: 'Dark with energetic orange diagonal stripes. For gyms, leisure centres and stadiums.',
    widget_theme: 'dark',
    accent: '#f97316',
    html: (o) => `<main class="pulse">
  <div class="pulse-card">
    <div class="pulse-head"><img class="pulse-logo" src="${logo(o.accent, '#111827')}" alt="Logo"><span class="pulse-chip">MEMBER WIFI</span></div>
    <h1 class="pulse-title">${o.title || 'Train hard. Stay connected.'}</h1>
    <p class="pulse-lede">${o.subtitle || 'Stream your playlist and track your workout.'}</p>
    <div data-portal-login="1" class="portal-login-slot"></div>
  </div>
</main>`,
    css: (o) => `body { margin: 0; background: #0b0f17; font-family: ${FONT}; -webkit-font-smoothing: antialiased; }
.pulse { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 40px 16px; box-sizing: border-box;
  background: repeating-linear-gradient(135deg, rgba(249,115,22,.07) 0px, rgba(249,115,22,.07) 18px, rgba(11,15,23,0) 18px, rgba(11,15,23,0) 44px), linear-gradient(180deg, #0b0f17 0%, #111827 100%); }
.pulse-card { width: 100%; max-width: 410px; background: #111827; border: 1px solid #1f2937; border-top: 4px solid ${o.accent}; border-radius: 18px; padding: 26px 24px; box-sizing: border-box;
  box-shadow: 0 30px 70px -30px rgba(0,0,0,.8); }
.pulse-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
.pulse-logo { width: 44px; height: 44px; border-radius: 12px; }
.pulse-chip { font-size: 11px; font-weight: 800; letter-spacing: .16em; color: #111827; background: ${o.accent}; padding: 5px 10px; border-radius: 6px; }
.pulse-title { font-size: 30px; line-height: 1.05; letter-spacing: -0.03em; font-weight: 900; text-transform: uppercase; font-style: italic; color: #ffffff; margin: 0 0 10px; }
.pulse-lede { font-size: 15px; color: #9ca3af; margin: 0 0 22px; line-height: 1.5; }
@media (max-width: 480px) { .pulse-card { padding: 22px 18px; } .pulse-title { font-size: 26px; } }`,
  },
};

function list() {
  return Object.entries(templates).map(([id, t]) => ({ id, tag: t.tag || 'General', name: t.name, description: t.description, widget_theme: t.widget_theme, accent: t.accent }));
}

function build(id, opts = {}) {
  const t = templates[id] || templates.aurora;
  const o = { accent: opts.accent || t.accent, title: opts.title, subtitle: opts.subtitle };
  return { html: t.html(o), css: t.css(o), widget_theme: t.widget_theme, accent: o.accent };
}

module.exports = { list, build, logo };
