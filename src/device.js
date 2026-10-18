// Turn a browser user-agent into a short, human description ("iPhone · iOS 18.1", "Windows PC", "Android · Pixel 8").
function describeAgent(ua) {
  const s = String(ua || '');
  if (!s) return null;
  let m;
  if ((m = s.match(/iPhone OS (\d+)[_.](\d+)/))) return { type: 'phone', label: `iPhone · iOS ${m[1]}.${m[2]}` };
  if ((m = s.match(/iPad.*OS (\d+)[_.](\d+)/))) return { type: 'tablet', label: `iPad · iPadOS ${m[1]}.${m[2]}` };
  if ((m = s.match(/Android (\d+(?:\.\d+)?)(?:;\s*([^;)]+))?/))) {
    const model = (m[2] || '').replace(/\bBuild\/.*$/, '').trim();
    const tablet = !/Mobile/.test(s);
    return { type: tablet ? 'tablet' : 'phone', label: `Android ${m[1]}${model && model !== 'K' ? ` · ${model}` : ''}` };
  }
  if (/Windows NT/.test(s)) return { type: 'computer', label: 'Windows PC' };
  if (/CrOS/.test(s)) return { type: 'computer', label: 'Chromebook' };
  if ((m = s.match(/Mac OS X (\d+)[_.](\d+)/))) return { type: 'computer', label: /Mobile\//.test(s) ? 'iPad' : 'Mac' };
  if (/Linux/.test(s)) return { type: 'computer', label: 'Linux' };
  return { type: 'other', label: null };
}

function formatBytes(n) {
  if (!n) return '0 MB';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${u[i]}`;
}

// UniFi reports signal in dBm (e.g. -55). Bucket it so admins don't have to read dBm.
function signalLabel(dbm) {
  if (typeof dbm !== 'number') return null;
  if (dbm >= -60) return 'Excellent';
  if (dbm >= -67) return 'Good';
  if (dbm >= -75) return 'Fair';
  return 'Weak';
}

module.exports = { describeAgent, formatBytes, signalLabel };
