// Default values for settings, profiles and the starter page designs.
const templates = require('./templates');

// Built-in (local) sign-in methods. SSO providers are separate instances managed in sso.js; a profile enables
// one by storing methods[<provider id>] = { enabled: true }.
const METHOD_KEYS = ['voucher', 'password', 'email', 'click'];

const METHOD_LABELS = {
  click: 'Click-through (accept terms)',
  email: 'Email / name registration',
  password: 'Shared password',
  voucher: 'Voucher code',
};

function methods() {
  return {
    click: { enabled: false, button_text: 'Continue as guest' },
    email: { enabled: false, require_name: true, marketing_optin: false },
    password: { enabled: false, password: '' },
    voucher: { enabled: false },
  };
}

function options() {
  return {
    minutes: 480,          // session length for non-voucher logins
    up_kbps: 0,            // 0 = unlimited
    down_kbps: 0,
    data_mb: 0,
    redirect_url: '',      // empty = the page the guest originally requested
    terms_enabled: true,
    terms_mode: 'implied',  // implied = "By continuing you agree…" · checkbox = must tick a box
    widget_theme: 'light',  // light | dark - match the login box to your page
    terms_text: 'By connecting you agree to use this network responsibly and lawfully. Access may be monitored and can be withdrawn at any time.',
    sso_allowed_domains: '', // comma separated, e.g. example.com  (empty = any)
    // SSO grace period: brief internet while a guest finishes SSO (e.g. approving in Microsoft Authenticator)
    maintenance: false,     // maintenance mode: guests see the page but can't sign in
    maintenance_message: 'We\u2019re just setting things up. WiFi sign-in will be available again shortly.',
    sso_grace_enabled: false,
    sso_grace_minutes: 5,
    sso_grace_kbps: 2000,    // speed cap during the grace period, 0 = unlimited
    sso_grace_cooldown: 60,  // minutes before the same device can get another grace period
    accent: '#2563eb',
    success_message: "You're connected! Enjoy the internet.",
  };
}

function unifi() {
  return {
    controller_type: 'unifios', // unifios (UCG/UDM/Cloud Key Gen2+) | standalone (self-hosted controller, e.g. for a USG)
    url: 'https://192.168.1.1',
    site: 'default',
    auth_mode: 'credentials', // credentials | apikey
    username: '',
    password: '',
    api_key: '',
    verify_tls: false,
  };
}

function ssidSync() {
  return {
    enabled: true,          // poll the controller for portal-enabled SSIDs
    auto_create: true,      // create a profile for each new one (copied from the default profile)
    interval_min: 5,
  };
}

function designHtml(name) { return templates.build('aurora', { title: name ? `${name} WiFi` : undefined }).html; }
function designCss(accent) { return templates.build('aurora', { accent }).css; }

function seedProfiles() {
  const guestMethods = methods();
  guestMethods.voucher.enabled = true;
  guestMethods.click.enabled = true;
  guestMethods.email.enabled = false;

  const staffMethods = methods();
  staffMethods.password.enabled = true;
  staffMethods.password.password = 'staff-' + Math.random().toString(36).slice(2, 8);

  const guest = templates.build('aurora');
  const staff = templates.build('night');
  return [
    {
      name: 'Guest',
      ssids: 'Guest',
      is_default: true,
      methods: guestMethods,
      options: { ...options(), minutes: 240, down_kbps: 20000, up_kbps: 5000, accent: guest.accent, widget_theme: guest.widget_theme },
      design_html: guest.html,
      design_css: guest.css,
    },
    {
      name: 'Staff',
      ssids: 'Staff',
      is_default: false,
      methods: staffMethods,
      options: { ...options(), minutes: 720, accent: staff.accent, widget_theme: staff.widget_theme, terms_enabled: false },
      design_html: staff.html,
      design_css: staff.css,
    },
  ];
}

module.exports = { ssidSync, METHOD_KEYS, METHOD_LABELS, methods, options, unifi, designHtml, designCss, seedProfiles };
