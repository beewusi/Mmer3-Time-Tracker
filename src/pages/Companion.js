import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from '../supabase';
import FaceCheck from '../components/FaceCheck';
import { usePresenceChecks, recordAway } from '../lib/useSessionWatch';
import { loadSecuritySettings } from '../lib/security';
import { dateToHHMM } from '../lib/time';
import { HourglassIcon, FaceIcon, ImageIcon, ClockIcon, LogoutIcon } from '../icons';
import './Dashboard.css';
import './Security.css';
import './Companion.css';

// /companion: the page the desktop app shows. Runs in the background while
// the employee is clocked in: heartbeats, away time from the computer itself,
// presence checks (window pops up) and screenshots.
// window.mmer3Desktop comes from desktop/preload.js. Opened in a normal
// browser it just says to use the desktop app.

const desktop = typeof window !== 'undefined' ? window.mmer3Desktop : null;
const HEARTBEAT_MS = 60 * 1000;
const IDLE_POLL_MS = 30 * 1000;
const IDLE_AFTER_SECONDS = 60;
const SHOT_MAX_WIDTH = 1024;
const SHOT_QUALITY = 0.55;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// all screens side by side, scaled down, one JPEG
async function combineScreens(screens) {
  const imgs = await Promise.all(screens.map(s => loadImage(s.dataUrl)));
  const totalW = imgs.reduce((w, i) => w + i.width, 0);
  const maxH = Math.max(...imgs.map(i => i.height));
  const scale = Math.min(1, SHOT_MAX_WIDTH * Math.max(1, imgs.length * 0.75) / totalW);
  const c = document.createElement('canvas');
  c.width = Math.round(totalW * scale);
  c.height = Math.round(maxH * scale);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0F172A';
  ctx.fillRect(0, 0, c.width, c.height);
  let x = 0;
  imgs.forEach(i => {
    ctx.drawImage(i, x, 0, i.width * scale, i.height * scale);
    x += i.width * scale;
  });
  return new Promise(resolve => c.toBlob(resolve, 'image/jpeg', SHOT_QUALITY));
}

function Companion({ user, onLogout }) {
  const [profileName, setProfileName] = useState('');
  const [status, setStatus] = useState(null);
  const [settings, setSettings] = useState(null);
  const [shotsToday, setShotsToday] = useState(0);
  const [lastShot, setLastShot] = useState(null);
  const [checksToday, setChecksToday] = useState({ passed: 0, total: 0 });
  const [faceOpen, setFaceOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [perms, setPerms] = useState(null);
  const idleRef = useRef({ state: 'active', since: null });
  const shotTimerRef = useRef(null);

  const working = status?.status === 'clocked_in';
  const live = working || status?.status === 'on_break';

  const loadStatus = useCallback(async () => {
    const { data } = await supabase.from('employee_status').select('*').eq('user_id', user.id).maybeSingle();
    setStatus(data || null);
  }, [user.id]);

  const loadToday = useCallback(async () => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const [sc, pc] = await Promise.all([
      supabase.from('screenshots').select('taken_at').eq('user_id', user.id).gte('taken_at', start.toISOString()).order('taken_at', { ascending: false }),
      supabase.from('presence_checks').select('result, due_at').eq('user_id', user.id).gte('due_at', start.toISOString()).lte('due_at', new Date().toISOString())
    ]);
    setShotsToday((sc.data || []).length);
    setLastShot(sc.data?.[0]?.taken_at || null);
    const list = pc.data || [];
    setChecksToday({ passed: list.filter(c => c.result === 'passed').length, total: list.length });
  }, [user.id]);

  useEffect(() => {
    supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle()
      .then(({ data }) => setProfileName(data?.full_name || user.email));
    loadSecuritySettings().then(setSettings);
    loadStatus();
    loadToday();
    const channel = supabase
      .channel(`companion-status-${user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'employee_status', filter: `user_id=eq.${user.id}` }, loadStatus)
      .subscribe();
    const poll = setInterval(() => { loadStatus(); loadToday(); }, 60000);
    return () => {
      clearInterval(poll);
      supabase.removeChannel(channel);
    };
  }, [user.id, user.email, loadStatus, loadToday]);

  // Mac: Screen Recording / Camera allowed?
  useEffect(() => {
    if (!desktop?.permissions) return undefined;
    const check = () => desktop.permissions().then(setPerms).catch(() => {});
    check();
    const t = setInterval(check, 60000);
    return () => clearInterval(t);
  }, []);

  // tell the tray what's going on
  useEffect(() => {
    desktop?.setStatus?.(working ? 'working' : live ? 'break' : 'off');
  }, [working, live]);

  // ---------- heartbeat + away time ----------
  useEffect(() => {
    if (!live || !desktop) return undefined;
    const beat = async () => {
      const wifi = desktop.getWifiName ? await desktop.getWifiName().catch(() => null) : null;
      await supabase.from('heartbeats').upsert({
        user_id: user.id, source: 'desktop', idle_state: idleRef.current.state, wifi_name: wifi
      }).then(() => {}, () => {});
    };
    beat();
    const t = setInterval(beat, HEARTBEAT_MS);

    const checkIdle = async () => {
      const info = await desktop.getIdle();
      const state = info.locked ? 'locked' : info.idleSeconds >= IDLE_AFTER_SECONDS ? 'idle' : 'active';
      const prev = idleRef.current;
      if (state !== 'active' && prev.state === 'active') {
        idleRef.current = { state, since: new Date(Date.now() - (state === 'idle' ? info.idleSeconds * 1000 : 0)) };
      } else if (state === 'active' && prev.state !== 'active') {
        idleRef.current = { state: 'active', since: null };
        if (working) await recordAway(user.id, prev.state, prev.since, new Date(), 'desktop');
      } else if (state !== prev.state) {
        idleRef.current = { ...prev, state };
      }
    };
    const i = setInterval(checkIdle, IDLE_POLL_MS);
    const off = desktop.onPower?.(evt => { if (evt === 'unlock-screen' || evt === 'resume') checkIdle(); });
    return () => {
      clearInterval(t);
      clearInterval(i);
      if (off) off();
    };
  }, [live, working, user.id]);

  // ---------- screenshots ----------
  const takeScreenshot = useCallback(async () => {
    try {
      const screens = await desktop.capture();
      if (!screens?.length) return;
      const blob = await combineScreens(screens);
      const path = `${user.id}/shot-${Date.now()}.jpg`;
      const { error } = await supabase.storage.from('screenshots').upload(path, blob, { contentType: 'image/jpeg' });
      if (error) throw error;
      const { data: st } = await supabase.from('employee_status').select('session_id, status').eq('user_id', user.id).maybeSingle();
      if (st?.status !== 'clocked_in') return;
      await supabase.from('screenshots').insert({ user_id: user.id, session_id: st.session_id, path, screen_count: screens.length });
      loadToday();
    } catch (err) {
      console.log('Screenshot not saved:', err?.message || err);
    }
  }, [user.id, loadToday]);

  useEffect(() => {
    const perHour = Number(settings?.screenshots_per_hour ?? 0);
    if (!working || !desktop || !perHour) return undefined;
    // one per slot at a random point in it, so the time can't be guessed
    const slotMs = (60 / perHour) * 60 * 1000;
    let cancelled = false;
    const schedule = () => {
      const wait = slotMs * (0.35 + Math.random() * 0.9);
      shotTimerRef.current = setTimeout(async () => {
        if (cancelled) return;
        await takeScreenshot();
        schedule();
      }, wait);
    };
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(shotTimerRef.current);
    };
  }, [working, settings, takeScreenshot]);

  // ---------- presence checks ----------
  const { openCheck, answer } = usePresenceChecks(user, working, 'desktop');
  const shownForRef = useRef(null);
  useEffect(() => {
    if (openCheck && shownForRef.current !== openCheck.id) {
      shownForRef.current = openCheck.id;
      setMessage('');
      desktop?.showWindow?.();
      desktop?.notify?.('Presence check', 'Show your face within 5 minutes.');
    }
    if (!openCheck) setFaceOpen(false);
  }, [openCheck]);

  async function handleFace(result) {
    setFaceOpen(false);
    try {
      const res = await answer(openCheck, result);
      setMessage(res?.result === 'passed' ? 'Presence check done. Thanks.' : 'Sent. It didn’t match, so your admin will take a look.');
    } catch (err) {
      setMessage(err.message || 'The presence check couldn’t be sent.');
    }
    loadToday();
  }

  if (!desktop) {
    return (
      <div className="companion">
        <div className="companion-card">
          <div className="companion-brand"><HourglassIcon width={20} height={20} /> Mmerℇ</div>
          <p>This page is for the Mmerℇ desktop app. Open the app on your work laptop, or go to your <a href="/">dashboard</a>.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="companion dashboard-layout">
      <div className="companion-top">
        <div className="companion-brand"><HourglassIcon width={18} height={18} /> Mmerℇ <span>Desktop</span></div>
        <button className="companion-signout" onClick={onLogout} title="Sign out"><LogoutIcon width={15} height={15} /></button>
      </div>

      <div className="companion-body">
        <p className="companion-name">{profileName}</p>
        <div className={`companion-status companion-status-${working ? 'on' : live ? 'break' : 'off'}`}>
          <ClockIcon width={16} height={16} />
          {working && `Clocked in since ${dateToHHMM(new Date(status.clock_in_at))}`}
          {!working && live && 'On a break'}
          {!live && 'Not clocked in'}
        </div>

        {openCheck && (
          <div className="companion-check">
            <FaceIcon width={18} height={18} />
            <div>
              <strong>Presence check</strong>
              <span>Before {new Date(openCheck.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <button className="btn-primary" onClick={() => setFaceOpen(true)}>Start</button>
          </div>
        )}
        {message && <p className="companion-message">{message}</p>}

        {perms && (perms.screen !== 'granted' || perms.camera === 'denied') && (
          <div className="companion-warn">
            {perms.screen !== 'granted' && <p>Screen Recording isn’t allowed for Mmerℇ yet, so screenshots come out blank.</p>}
            {perms.camera === 'denied' && <p>The camera is blocked for Mmerℇ, so presence checks can’t see you.</p>}
            <button className="sec-btn-secondary" onClick={() => desktop.openPrivacySettings()}>Open Privacy &amp; Security</button>
          </div>
        )}

        <div className="companion-stats">
          <div><FaceIcon width={14} height={14} /> Presence checks today <strong>{checksToday.total ? `${checksToday.passed}/${checksToday.total}` : '–'}</strong></div>
          <div><ImageIcon width={14} height={14} /> Screenshots today <strong>{shotsToday}</strong></div>
          {lastShot && <div><ClockIcon width={14} height={14} /> Last screenshot <strong>{dateToHHMM(new Date(lastShot))}</strong></div>}
        </div>

        <p className="companion-note">
          Keep this app running while you work. Closing the window keeps it in the tray. Screenshots and checks only happen while you’re clocked in. You can see them on My Activity.
        </p>
        <button className="sec-btn-secondary companion-open" onClick={() => desktop.openExternal(window.location.origin + '/')}>
          Open Mmerℇ in the browser
        </button>
      </div>

      {faceOpen && openCheck && (
        <FaceCheck mode="presence" onDone={handleFace} onCancel={() => setFaceOpen(false)} />
      )}
    </div>
  );
}

export default Companion;
