// Mmerℇ desktop app.
// A small window that shows the web app's /companion page and stays in the
// tray. It starts when the laptop starts, and while the employee is clocked
// in it sends heartbeats, takes screenshots and pops up for presence checks.
// Everything else (sign-in, saving, rules) is the web app.
//
// Site address: config.json ("appUrl"), or MMER3_URL when testing.
// Build: npm install, then npm run dist:win (on Windows) or dist:mac (on a Mac).

const {
  app, BrowserWindow, Tray, Menu, nativeImage, desktopCapturer, powerMonitor,
  ipcMain, Notification, shell, session, systemPreferences, screen, dialog
} = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

// config.json sits next to the app's files after install (resources folder),
// so the site address can be changed without rebuilding
function readConfig() {
  for (const dir of [process.resourcesPath, __dirname]) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    } catch {
      // try the next place
    }
  }
  return {};
}

const APP_URL = (process.env.MMER3_URL || readConfig().appUrl || '').replace(/\/+$/, '');
const COMPANION_URL = `${APP_URL}/companion`;
const APP_ORIGIN = (() => {
  try { return new URL(APP_URL).origin; } catch { return ''; }
})();

// exact match on the site's origin (startsWith would let
// https://our-site.onrender.com.somewhere-else.com through)
function isOurs(url) {
  try {
    return !!APP_ORIGIN && new URL(url).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

function openOutside(url) {
  try {
    if (['https:', 'http:', 'mailto:'].includes(new URL(url).protocol)) shell.openExternal(url);
  } catch {
    // not a link
  }
}

// every request from the page has to come from our site
function fromUs(event) {
  return isOurs(event.senderFrame?.url || '');
}

let win = null;
let tray = null;
let quitting = false;
let trayStatus = 'off';

// one copy only; opening it again just shows the window
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on('second-instance', () => showWindow());

function iconPath(name) {
  return path.join(__dirname, 'build', name);
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: 380,
    height: 600,
    x: workArea.x + workArea.width - 400,
    y: workArea.y + workArea.height - 620,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'Mmerℇ',
    icon: iconPath('icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false   // timers keep running while hidden
    }
  });

  win.loadURL(COMPANION_URL);

  // closing hides it; it keeps running in the tray
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  // links to anything else open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isOurs(url)) {
      e.preventDefault();
      openOutside(url);
    }
  });

  // site couldn't load (offline, wrong address): try again in a minute
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (code === -3) return;   // cancelled, e.g. a redirect
    console.log('Load failed', code, desc, url);
    setTimeout(() => win && !win.isDestroyed() && win.loadURL(COMPANION_URL), 60000);
  });

  // first run: show the window so they can sign in
  win.once('ready-to-show', () => {
    if (!app.getLoginItemSettings().wasOpenedAtLogin) showWindow();
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.setAlwaysOnTop(true);
  win.focus();
  app.focus({ steal: true });
  setTimeout(() => win && !win.isDestroyed() && win.setAlwaysOnTop(false), 3000);
}

function updateTray() {
  if (!tray) return;
  const label = { working: 'Clocked in', break: 'On a break', off: 'Not clocked in' }[trayStatus] || '';
  tray.setToolTip(`Mmerℇ: ${label}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Mmerℇ: ${label}`, enabled: false },
    { type: 'separator' },
    { label: 'Show', click: () => showWindow() },
    { label: 'Open Mmerℇ in the browser', click: () => shell.openExternal(`${APP_URL}/`) },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true;
        app.quit();
      }
    }
  ]));
}

function createTray() {
  const img = nativeImage.createFromPath(iconPath(process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.on('click', () => showWindow());
  updateTray();
}

// ---------- what the /companion page can ask for (preload.js) ----------

ipcMain.handle('capture', async (e) => {
  if (!fromUs(e)) return [];
  const displays = screen.getAllDisplays();
  const biggest = displays.reduce((m, d) => Math.max(m, d.size.width * d.scaleFactor), 0) || 1920;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.min(biggest, 2560), height: Math.min(biggest, 2560) }
  });
  return sources
    .filter(s => !s.thumbnail.isEmpty())
    .map(s => {
      const size = s.thumbnail.getSize();
      return { dataUrl: `data:image/jpeg;base64,${s.thumbnail.toJPEG(70).toString('base64')}`, width: size.width, height: size.height };
    });
});

ipcMain.handle('idle', (e) => (!fromUs(e) ? { idleSeconds: 0, locked: false } : {
  idleSeconds: powerMonitor.getSystemIdleTime(),
  locked: powerMonitor.getSystemIdleState(60) === 'locked'
}));

ipcMain.handle('show-window', (e) => { if (fromUs(e)) showWindow(); });

// Wi-Fi name, a second check that someone is in the office. Asked from the
// system's own tools; null if not on Wi-Fi or the system won't say.
function run(cmd, args) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: 4000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

ipcMain.handle('wifi', async (e) => {
  if (!fromUs(e)) return null;
  let name = null;
  if (process.platform === 'win32') {
    const out = await run('netsh', ['wlan', 'show', 'interfaces']);
    const m = out.match(/^\s*SSID\s*:\s*(.+)$/m);
    name = m ? m[1].trim() : null;
  } else if (process.platform === 'darwin') {
    const out = await run('ipconfig', ['getsummary', 'en0']);
    const m = out.match(/\bSSID : (.+)/);
    name = m ? m[1].trim() : null;
    if (!name || name === '<redacted>') {
      const alt = await run('networksetup', ['-getairportnetwork', 'en0']);
      const m2 = alt.match(/Current Wi-Fi Network: (.+)/);
      name = m2 ? m2[1].trim() : null;
    }
  } else {
    name = (await run('iwgetid', ['-r'])).trim() || null;
  }
  if (name === '<redacted>') name = null;
  return name ? name.slice(0, 64) : null;
});

// Mac only: screenshots need Screen Recording allowed in System Settings,
// otherwise they come out as just the desktop background
ipcMain.handle('permissions', (e) => {
  if (!fromUs(e)) return null;
  if (process.platform !== 'darwin') return { camera: 'granted', screen: 'granted' };
  return {
    camera: systemPreferences.getMediaAccessStatus('camera'),
    screen: systemPreferences.getMediaAccessStatus('screen')
  };
});

ipcMain.handle('open-privacy-settings', () => {
  if (process.platform === 'darwin') {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  }
});

ipcMain.handle('notify', (e, title, body) => {
  if (!fromUs(e) || !Notification.isSupported()) return;
  const n = new Notification({ title: String(title).slice(0, 80), body: String(body).slice(0, 200) });
  n.on('click', () => showWindow());
  n.show();
});

ipcMain.handle('open-external', (e, url) => {
  if (fromUs(e) && typeof url === 'string' && isOurs(url)) shell.openExternal(url);
});

ipcMain.handle('set-status', (e, status) => {
  if (!fromUs(e) || !['working', 'break', 'off'].includes(status)) return;
  trayStatus = status;
  updateTray();
});

// lock / unlock / sleep / wake go straight to the page
for (const evt of ['lock-screen', 'unlock-screen', 'suspend', 'resume']) {
  powerMonitor.on(evt, () => {
    if (win && !win.isDestroyed()) win.webContents.send('power', evt);
  });
}

// ---------- start ----------

app.whenReady().then(async () => {
  if (!APP_ORIGIN || /YOUR-SITE/.test(APP_URL)) {
    dialog.showErrorBox('Mmerℇ', 'The site address isn’t set. Put it in config.json ("appUrl") next to the app, then open Mmerℇ again.');
    app.quit();
    return;
  }

  // camera for presence checks; nothing else, and only for our site
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const ours = isOurs(details.requestingUrl || wc.getURL());
    callback(ours && (permission === 'media' || permission === 'notifications'));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) =>
    origin === APP_ORIGIN && (permission === 'media' || permission === 'notifications'));

  if (process.platform === 'darwin') {
    // asks once; the Mac remembers the answer
    try { await systemPreferences.askForMediaAccess('camera'); } catch { /* older macOS */ }
  }

  // start with the laptop, hidden in the tray
  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });

  createTray();
  createWindow();
});

app.on('activate', () => showWindow());

// keep running with the window closed (tray app)
app.on('window-all-closed', (e) => e.preventDefault());

app.on('before-quit', () => { quitting = true; });
