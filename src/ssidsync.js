// Discovers SSIDs on the UniFi controller and auto-creates a profile for any portal-enabled SSID that doesn't have one.
const { getSetting, setSetting, profiles } = require('./db');
const defaults = require('./defaults');
const unifi = require('./unifi');

function config() { return { ...defaults.ssidSync(), ...getSetting('ssid_sync', {}) }; }

function matchProfile(all, ssid) {
  const s = ssid.toLowerCase();
  return all.find((p) => p.ssidList.some((x) => x.toLowerCase() === s)) || null;
}

/** Fetch WLANs from the controller, create missing profiles, and cache the result for the dashboard. */
async function sync({ manual = false } = {}) {
  const cfg = config();
  const unifiCfg = getSetting('unifi', {});
  if (!unifiCfg.username && !unifiCfg.api_key) return { skipped: 'UniFi not configured' };
  if (!cfg.enabled && !manual) return { skipped: 'sync disabled' };
  try {
    const wlans = await unifi.listWlans();
    const created = [];
    if (cfg.auto_create) {
      const base = profiles.all().find((p) => p.is_default) || profiles.all()[0];
      for (const w of wlans) {
        if (!w.portal || matchProfile(profiles.all(), w.name)) continue;
        profiles.create({
          name: w.name,
          ssids: w.name,
          is_default: false,
          auto_created: true,
          methods: base ? base.methods : defaults.methods(),
          options: base ? base.options : defaults.options(),
          design_html: base ? base.design_html : undefined,
          design_css: base ? base.design_css : undefined,
          design_project: base ? base.design_project : null,
        });
        created.push(w.name);
        console.log(`[ssid-sync] created profile for new SSID "${w.name}"`);
      }
    }
    const all = profiles.all();
    const list = wlans.map((w) => {
      const m = matchProfile(all, w.name);
      return { ...w, profile_id: m ? m.id : null, profile_name: m ? m.name : null };
    });
    setSetting('wlans', { at: Math.floor(Date.now() / 1000), list, error: null, created });
    return { list, created };
  } catch (e) {
    const prev = getSetting('wlans', {}) || {};
    setSetting('wlans', { ...prev, at: Math.floor(Date.now() / 1000), error: e.message });
    console.error('[ssid-sync]', e.message);
    if (manual) throw e;
    return { error: e.message };
  }
}

let timer = null;
function start() {
  const schedule = () => {
    clearTimeout(timer);
    const mins = Math.max(1, Number(config().interval_min) || 5);
    timer = setTimeout(async () => { await sync(); schedule(); }, mins * 60_000);
    timer.unref();
  };
  setTimeout(() => sync().finally(schedule), 5000).unref();
}

module.exports = { sync, start, config };
