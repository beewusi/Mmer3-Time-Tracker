# Mmerℇ desktop app

Small tray app for work laptops. It shows the web app's `/companion` page and,
while the employee is clocked in:

- sends a heartbeat every minute (gaps show on the admin Activity page)
- notices when the computer is idle or locked
- pops up for presence checks (face + blink)
- takes 1–3 screenshots an hour at random times (set in admin Settings)

It starts with the laptop and closes to the tray. Sign in once with the
employee's own account.

## Site address

`config.json` → `appUrl`, e.g. `https://my-site.onrender.com`. After install
it's in the app's resources folder, so it can be changed without rebuilding:

- Windows: `%LOCALAPPDATA%\Programs\Mmer3\resources\config.json`
- Mac: `Mmer3.app/Contents/Resources/config.json`

## Run / build

```
cd desktop
npm install
npm start                 # try it (uses config.json)
npm run dist:win          # on Windows → dist/Mmer3 Setup 1.0.0.exe
npm run dist:mac          # on a Mac   → dist/Mmer3-1.0.0.dmg
```

Not code-signed (our own laptops):

- Windows: SmartScreen says "Windows protected your PC" → More info → Run anyway.
- Mac: right-click the app → Open → Open (first time only). Then allow
  Camera and Screen Recording in System Settings → Privacy & Security when asked.
