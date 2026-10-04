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

// Mac: small scripts run with the Mac's own script runner (osascript), which
// can use the system's Location and Wi-Fi parts directly. Run from Mmer3, so
// the Mac asks "Mmer3 would like to use your location" once.
// Asks for Location, waits a few seconds for the answer, prints the status
// (0 not asked yet, 1 restricted, 2 denied, 3/4 allowed).
const MAC_ASK_LOCATION = `
ObjC.import('CoreLocation');
ObjC.import('Foundation');
var m = $.CLLocationManager.alloc.init;
m.requestWhenInUseAuthorization;
m.startUpdatingLocation;
$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(10));
m.stopUpdatingLocation;
String($.CLLocationManager.authorizationStatus);
`;

// The router ID (and name) straight from the Wi-Fi; empty if the Mac hides it.
const MAC_READ_WIFI = `
ObjC.import('CoreWLAN');
var i = $.CWWiFiClient.sharedWiFiClient.interface;
var out = '';
if (i && !i.isNil()) {
  var b = i.bssid, s = i.ssid;
  out = (b && !b.isNil() ? b.js : '') + '|' + (s && !s.isNil() ? s.js : '');
}
out;
`;

// "6c:5a:b0:9e:1f:a4|Office" -> { router, name }
function parseMacScript(out) {
  const [router, ...rest] = String(out || '').trim().split('|');
  return { router: normaliseRouter(router), name: cleanName(rest.join('|')) };
}

module.exports = { normaliseRouter, parseWindows, parseMac, parseMacScript, MAC_ASK_LOCATION, MAC_READ_WIFI };
