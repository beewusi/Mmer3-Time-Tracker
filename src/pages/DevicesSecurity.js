import { useEffect, useState } from 'react';
import { supabase } from '../supabase';
import FaceCheck from '../components/FaceCheck';
import {
  passkeysSupported, listMyDevices, registerThisLaptop, getDeviceKey,
  getMyFaceProfile, saveFaceProfile, withdrawFaceConsent, loadSecuritySettings
} from '../lib/security';
import { DESKTOP_DOWNLOADS, DESKTOP_VERSION, thisComputer } from '../lib/downloads';
import { formatAgo, formatDayTime } from '../lib/time';
import { LaptopIcon, FaceIcon, MonitorIcon, AlertIcon } from '../icons';
import './Security.css';

// Devices & Security (employee). Register this work laptop, set up the face
// check, see whether the desktop app is running.

function guessLaptopName() {
  const ua = navigator.userAgent || '';
  if (/Mac/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows laptop';
  if (/Linux/i.test(ua)) return 'Linux laptop';
  return 'Work laptop';
}

const FACE_STATUS = {
  pending: { label: 'Saving…', tone: 'pending' },
  approved: { label: 'Active', tone: 'active' },
  rejected: { label: 'Retake needed', tone: 'danger' },
  withdrawn: { label: 'Consent withdrawn', tone: 'neutral' }
};

const DEVICE_STATUS = {
  pending: { label: 'Waiting for your admin', tone: 'pending' },
  approved: { label: 'Approved', tone: 'active' }
};

function DevicesSecurity({ user, onChanged }) {
  const [settings, setSettings] = useState(null);
  const [devices, setDevices] = useState([]);
  const [supported, setSupported] = useState(true);
  const [laptopName, setLaptopName] = useState(guessLaptopName);
  const [registering, setRegistering] = useState(false);
  const [deviceError, setDeviceError] = useState('');
  const [deviceNote, setDeviceNote] = useState('');

  const [face, setFace] = useState(null);
  const [faceLoaded, setFaceLoaded] = useState(false);
  const [consent, setConsent] = useState(false);
  const [showFaceCheck, setShowFaceCheck] = useState(false);
  const [faceSaving, setFaceSaving] = useState(false);
  const [faceError, setFaceError] = useState('');
  const [faceNote, setFaceNote] = useState('');
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);

  const [heartbeat, setHeartbeat] = useState(null);
  const thisDeviceKey = getDeviceKey();

  useEffect(() => {
    loadAll();
    passkeysSupported().then(setSupported);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadAll() {
    const [s, d, f, hb] = await Promise.all([
      loadSecuritySettings(),
      listMyDevices(user.id),
      getMyFaceProfile(),
      supabase.from('heartbeats').select('desktop_seen_at').eq('user_id', user.id).maybeSingle()
    ]);
    setSettings(s);
    setDevices(d);
    setFace(f);
    setFaceLoaded(true);
    setHeartbeat(hb?.data || null);
  }

  async function handleRegister() {
    setDeviceError('');
    setDeviceNote('');
    setRegistering(true);
    try {
      const device = await registerThisLaptop(laptopName);
      setDeviceNote(device?.status === 'approved'
        ? 'Laptop registered and approved. You can clock in from it now.'
        : 'Laptop registered. You weren’t on the office network, so your admin needs to approve it. You can clock in meanwhile; your hours count once it’s approved.');
      setDevices(await listMyDevices(user.id));
      onChanged && onChanged();
    } catch (err) {
      setDeviceError(err.message);
    }
    setRegistering(false);
  }

  async function handleFaceDone(result) {
    setShowFaceCheck(false);
    setFaceSaving(true);
    setFaceError('');
    try {
      await saveFaceProfile(user.id, result.descriptor, result.photoBlob);
      setFaceNote('Face check set up. It’s used every time you clock in.');
      setFace(await getMyFaceProfile());
      setConsent(false);
      onChanged && onChanged();
    } catch (err) {
      setFaceError(err.message || 'Couldn’t save your face. Please try again.');
    }
    setFaceSaving(false);
  }

  async function handleWithdraw() {
    setConfirmWithdraw(false);
    setFaceError('');
    try {
      await withdrawFaceConsent();
      setFace(await getMyFaceProfile());
      setFaceNote('Face check removed and your face data deleted.');
      onChanged && onChanged();
    } catch (err) {
      setFaceError(err.message || 'Couldn’t remove your face data.');
    }
  }

  const faceActive = face && face.status !== 'withdrawn';
  // once approved the photo is locked; the admin rejects it to allow a retake
  const faceLocked = face && face.status === 'approved';
  const thisLaptopRegistered = devices.some(d => d.device_key && d.device_key === thisDeviceKey);
  // one laptop each: another one can't be added until the admin removes it
  const myLaptop = devices.find(d => d.status === 'approved' || d.status === 'pending');
  const computer = thisComputer();
  const downloadOrder = computer === 'mac' ? ['mac', 'windows'] : ['windows', 'mac'];
  const faceInfo = face ? FACE_STATUS[face.status] || FACE_STATUS.pending : null;
  const faceOff = settings && settings.face_check_enabled === false;
  const desktopSeen = heartbeat?.desktop_seen_at ? new Date(heartbeat.desktop_seen_at) : null;
  const desktopRecent = desktopSeen && Date.now() - desktopSeen.getTime() < 10 * 60 * 1000;

  return (
    <div className="page sec-page">
      <div className="page-header">
        <div>
          <h1>Devices &amp; Security</h1>
          <p className="page-date">How Mmerℇ knows it’s you clocking in, from your own work laptop</p>
        </div>
      </div>

      {/* ---------- laptop ---------- */}
      <h2 className="reminders-subheading sec-first-heading">Work laptop</h2>
      <p className="page-date reminders-subnote">
        Register the one laptop you were given. At clock-in it asks for Windows Hello or Touch ID, so only that laptop can clock you in. Registered on the office network, it’s approved straight away. To change laptop, ask your admin to remove the old one.
      </p>
      <div className="reminders-list">
        {devices.map(d => {
          const info = DEVICE_STATUS[d.status] || DEVICE_STATUS.pending;
          const isThis = d.device_key && d.device_key === thisDeviceKey;
          return (
            <div className="reminder-item" key={d.id}>
              <div className="reminder-icon"><LaptopIcon width={18} height={18} /></div>
              <div className="reminder-info">
                <h3>
                  {d.label || 'Work laptop'}
                  {isThis && <span className="sec-tag">This laptop</span>}
                </h3>
                <p>
                  Registered {formatDayTime(d.created_at)}
                  {d.last_used_at ? ` · last used ${formatAgo(d.last_used_at)}` : ''}
                  {d.synced ? ' · passkey also saved to a phone or other device' : ''}
                </p>
                {d.status === 'pending' && (
                  <p>Registered outside the office network, so your admin approves it. You can clock in meanwhile; your hours count once it’s approved.</p>
                )}
              </div>
              <span className={`reminder-badge sec-badge-${info.tone}`}>{info.label}</span>
            </div>
          );
        })}

        {!thisLaptopRegistered && myLaptop && (
          <div className="reminder-item sec-item-warn">
            <div className="reminder-icon"><LaptopIcon width={18} height={18} /></div>
            <div className="reminder-info">
              <h3>This isn’t your registered laptop</h3>
              <p>
                You can only clock in from {myLaptop.label || 'your registered laptop'}. Got a new laptop, or changed browser? Ask your admin to remove the old one, then register this one here.
              </p>
            </div>
          </div>
        )}

        {!thisLaptopRegistered && !myLaptop && (
          <div className="reminder-item sec-action-item">
            <div className="reminder-icon"><LaptopIcon width={18} height={18} /></div>
            <div className="reminder-info">
              <h3>Register this laptop</h3>
              {supported ? (
                <p>You’ll be asked for your Windows Hello PIN, fingerprint or face, or Touch ID on a Mac.</p>
              ) : (
                <p>This browser or laptop can’t create a passkey. Use Chrome or Edge on Windows, or Safari or Chrome on a Mac, with Windows Hello or Touch ID set up.</p>
              )}
              {supported && (
                <div className="sec-inline-form">
                  <input
                    type="text"
                    value={laptopName}
                    maxLength={60}
                    onChange={e => setLaptopName(e.target.value)}
                    aria-label="Name for this laptop"
                  />
                  <button className="btn-primary" onClick={handleRegister} disabled={registering || !laptopName.trim()}>
                    {registering ? 'Waiting for the laptop…' : 'Register'}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      {deviceError && <div className="form-alert sec-msg">{deviceError}</div>}
      {deviceNote && <div className="form-success sec-msg">{deviceNote}</div>}

      {/* ---------- face ---------- */}
      <h2 className="reminders-subheading">Face check</h2>
      <p className="page-date reminders-subnote">
        A quick look at the camera when you clock in and during presence checks, so nobody else can clock in for you.
      </p>
      <div className="reminders-list">
        {faceOff && (
          <div className="reminder-item">
            <div className="reminder-icon"><FaceIcon width={18} height={18} /></div>
            <div className="reminder-info">
              <h3>Switched off</h3>
              <p>Your admin has switched the face check off for now.</p>
            </div>
          </div>
        )}

        {faceLoaded && face && (
          <div className="reminder-item">
            <div className="reminder-icon"><FaceIcon width={18} height={18} /></div>
            <div className="reminder-info">
              <h3>Your face</h3>
              <p>
                {face.status === 'withdrawn'
                  ? `Consent withdrawn ${formatDayTime(face.updated_at)}. Your face data and photo were deleted.`
                  : `Set up ${formatDayTime(face.updated_at || face.consent_at)} · consent given ${formatDayTime(face.consent_at)}`}
                {face.status === 'rejected' ? ' · your admin has asked for a new photo, please retake it' : ''}
                {faceLocked ? ' · to change your photo, ask your admin' : ''}
              </p>
              {faceLocked && (
                <button className="sec-btn-link sec-withdraw" onClick={() => setConfirmWithdraw(true)}>Withdraw consent</button>
              )}
            </div>
            <span className={`reminder-badge sec-badge-${faceInfo.tone}`}>{faceInfo.label}</span>
          </div>
        )}

        {faceLoaded && !faceLocked && (
          <div className="reminder-item sec-action-item">
            <div className="reminder-icon"><FaceIcon width={18} height={18} /></div>
            <div className="reminder-info">
              <h3>{faceActive ? 'Retake your face' : 'Set up your face check'}</h3>
              <p className="sec-face-tips">
                Before you start: take off caps, hats, sunglasses and face masks. Clear glasses are fine if you usually wear them. Sit facing a light, not with a window behind you.
              </p>
              <p>
                Your photo is turned into a face template (128 numbers) and compared on this computer. It’s only used to confirm it’s you, and you can withdraw consent at any time.{' '}
                <a href="/privacy" target="_blank" rel="noopener noreferrer">Privacy Notice</a>
              </p>
              <label className="sec-consent">
                <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
                <span>I agree to Mmerℇ using my face to confirm it’s me when I clock in and during presence checks, as described in the Privacy Notice.</span>
              </label>
              <div className="sec-inline-form">
                <button className="btn-primary" disabled={!consent || faceSaving} onClick={() => { setFaceNote(''); setFaceError(''); setShowFaceCheck(true); }}>
                  {faceSaving ? 'Saving…' : faceActive ? 'Retake' : 'Start camera'}
                </button>
                {faceActive && (
                  <button className="sec-btn-link" onClick={() => setConfirmWithdraw(true)}>Withdraw consent</button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      {faceError && <div className="form-alert sec-msg">{faceError}</div>}
      {faceNote && <div className="form-success sec-msg">{faceNote}</div>}

      {/* ---------- desktop app ---------- */}
      <h2 className="reminders-subheading">Desktop app</h2>
      <p className="page-date reminders-subnote">
        Runs in the background while you’re clocked in: presence checks and screenshots.
      </p>
      <div className="reminders-list">
        <div className="reminder-item">
          <div className="reminder-icon"><MonitorIcon width={18} height={18} /></div>
          <div className="reminder-info">
            <h3>Mmerℇ desktop app</h3>
            <p>
              {desktopSeen
                ? `Last in touch ${formatAgo(desktopSeen)}`
                : 'Not set up on this laptop yet. Download it below, install it, and sign in once with this account.'}
            </p>
            <div className="sec-inline-form sec-downloads">
              {downloadOrder.map(key => (
                <a
                  key={key}
                  className={key === computer ? 'btn-primary' : 'sec-btn-secondary'}
                  href={DESKTOP_DOWNLOADS[key].url}
                  target="_blank"
                  rel="noopener noreferrer">
                  {DESKTOP_DOWNLOADS[key].label}
                </a>
              ))}
            </div>
            <p className="sec-download-note">
              Version {DESKTOP_VERSION}. Windows: if it says “Windows protected your PC”, click More info → Run anyway. Mac: open the file, drag Mmerℇ to Applications, then right-click it → Open the first time.
            </p>
          </div>
          <span className={`reminder-badge sec-badge-${desktopRecent ? 'active' : 'neutral'}`}>
            {desktopRecent ? 'Running' : 'Not running'}
          </span>
        </div>
      </div>

      {confirmWithdraw && (
        <div className="popup-overlay">
          <div className="popup-box">
            <h3>Withdraw consent?</h3>
            <p>Your face template and setup photo will be deleted. Clocking in needs the face check, so you won’t be able to clock in until you set it up again. Speak to your admin if you need another way.</p>
            <div className="popup-buttons">
              <button className="popup-cancel" onClick={() => setConfirmWithdraw(false)}>Cancel</button>
              <button className="popup-confirm sec-danger" onClick={handleWithdraw}>Withdraw</button>
            </div>
          </div>
        </div>
      )}

      {showFaceCheck && (
        <FaceCheck
          mode="register"
          onDone={handleFaceDone}
          onCancel={() => setShowFaceCheck(false)}
        />
      )}

      {settings && settings.require_registered_device && !devices.some(d => d.status === 'approved' || d.status === 'pending') && (
        <p className="sec-footnote">
          <AlertIcon width={13} height={13} /> You can clock in once this laptop is registered and your face check is set up.
        </p>
      )}
    </div>
  );
}

export default DevicesSecurity;
