// Reading the Wi-Fi details from the system's own tools' output.
// Kept apart from main.js so it can be checked without starting the app.

// aa:bb:cc:dd:ee:ff, lower case; anything else = unknown
function normaliseRouter(value) {
  if (!value) return null;
  const parts = String(value).trim().toLowerCase().split(/[:-]/).map(p => p.padStart(2, '0'));
  if (parts.length !== 6 || parts.some(p => !/^[0-9a-f]{2}$/.test(p))) return null;
  const id = parts.join(':');
  return id === '00:00:00:00:00:00' ? null : id;
}

function cleanName(name) {
  if (!name || name === '<redacted>') return null;
  return name.trim().slice(0, 64) || null;
}

// netsh wlan show interfaces
function parseWindows(out) {
  const name = (out.match(/^\s*SSID\s*:\s*(.+)$/m) || [])[1];
  const router = (out.match(/^\s*(?:AP )?BSSID\s*:\s*([0-9a-fA-F:-]{11,17})/m) || [])[1];
  return { name: cleanName(name), router: normaliseRouter(router) };
}

// ipconfig getsummary en0 (Mac); networksetup output as a fallback for the name
function parseMac(summary, airport = '') {
  let name = cleanName((summary.match(/\bSSID : (.+)/) || [])[1]);
  const router = (summary.match(/\bBSSID : ([0-9a-fA-F:]{11,17})/) || [])[1];
  if (!name) name = cleanName((airport.match(/Current Wi-Fi Network: (.+)/) || [])[1]);
  return { name, router: normaliseRouter(router) };
}

module.exports = { normaliseRouter, parseWindows, parseMac };
