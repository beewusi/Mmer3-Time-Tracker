import { useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { signedPhotoUrl } from '../lib/security';
import { dateToHHMM } from '../lib/time';
import { FLAG_LABELS, FLAG_STATUS, flagSummary } from '../lib/flags';
import { FaceIcon, ImageIcon, FlagIcon, LaptopIcon, ClockIcon, XIcon } from '../icons';
import './Security.css';

// My Activity: what was checked during my own sessions on a given day.
// Clock-in checks, presence checks, screenshots, away time and anything
// marked for the admin.

const PRESENCE_RESULT = {
  passed: { label: 'Passed', tone: 'active' },
  failed: { label: 'Didn’t match', tone: 'danger' },
  missed: { label: 'Missed', tone: 'danger' },
  pending: { label: 'Waiting', tone: 'neutral' }
};

const FACE_RESULT = {
  match: 'Face matched',
  no_match: 'Face didn’t match',
  no_face: 'No face seen',
  not_registered: 'No face check set up',
  skipped: 'Face check off'
};

function dayBounds(day) {
  const start = new Date(day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start.toISOString(), end.toISOString()];
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function Thumb({ path, bucket = 'evidence', alt, onOpen }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true;
    signedPhotoUrl(path, bucket).then(u => { if (alive) setUrl(u); });
    return () => { alive = false; };
  }, [path, bucket]);
  if (!path) return null;
  return (
    <button className="act-thumb" onClick={() => url && onOpen(url)} aria-label={`Open ${alt}`}>
      {url ? <img src={url} alt={alt} /> : <span />}
    </button>
  );
}

// admin: same view for any employee, inside the admin page (Activity)
function MyActivity({ user, userId, admin = false, heading, headerActions, picker }) {
  const who = userId || user.id;
  const [day, setDay] = useState(() => new Date());
  const [loading, setLoading] = useState(true);
  const [evidence, setEvidence] = useState([]);
  const [checks, setChecks] = useState([]);
  const [shots, setShots] = useState([]);
  const [away, setAway] = useState([]);
  const [flags, setFlags] = useState([]);
  const [viewer, setViewer] = useState(null);
  const [reload, setReload] = useState(0);              // bumped when checks or flags change

  // today: picks up checks being answered or missed, and new flags, without a refresh
  useEffect(() => {
    if (!sameDay(day, new Date())) return undefined;
    const bump = () => setReload(n => n + 1);
    const channel = supabase
      .channel(`activity-${who}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'presence_checks', filter: `user_id=eq.${who}` }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'session_flags', filter: `user_id=eq.${who}` }, bump)
      .subscribe();
    const t = setInterval(bump, 60000);
    return () => { clearInterval(t); supabase.removeChannel(channel); };
  }, [day, who]);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!reload) setLoading(true);
      const [from, to] = dayBounds(day);
      const [ev, pc, sc, ae, fl] = await Promise.all([
        supabase.from('clock_evidence').select('*').eq('user_id', who).gte('created_at', from).lt('created_at', to).order('created_at'),
        supabase.from('presence_checks').select('*').eq('user_id', who).gte('due_at', from).lt('due_at', to).lte('due_at', new Date().toISOString()).order('due_at'),
        supabase.from('screenshots').select('*').eq('user_id', who).gte('taken_at', from).lt('taken_at', to).order('taken_at'),
        supabase.from('activity_events').select('*').eq('user_id', who).gte('started_at', from).lt('started_at', to).order('started_at'),
        supabase.from('session_flags').select('*').eq('user_id', who).gte('created_at', from).lt('created_at', to).order('created_at')
      ]);
      if (!alive) return;
      setEvidence(ev.data || []);
      setChecks(pc.data || []);
      setShots(sc.data || []);
      setAway(ae.data || []);
      setFlags(fl.data || []);
      setLoading(false);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, who, reload]);

  function shiftDay(n) {
    const d = new Date(day);
    d.setDate(d.getDate() + n);
    if (d > new Date()) return;
    setDay(d);
  }

  const isToday = sameDay(day, new Date());
  const passed = checks.filter(c => c.result === 'passed').length;
  const awayMinutes = away.reduce((sum, a) => sum + (a.ended_at ? (new Date(a.ended_at) - new Date(a.started_at)) / 60000 : 0), 0);
  const openFlags = flags.filter(f => f.status === 'open').length;
  const nothing = !loading && !evidence.length && !checks.length && !shots.length && !away.length && !flags.length;

  const dayNav = (
    <div className="act-day-nav">
      <button onClick={() => shiftDay(-1)} aria-label="Previous day">‹</button>
      <span>{isToday ? 'Today' : day.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
      <button onClick={() => shiftDay(1)} disabled={isToday} aria-label="Next day">›</button>
    </div>
  );

  return (
    <div className={admin ? 'sec-page sec-admin-activity' : 'page sec-page'}>
      {admin ? (
        <>
          <div className="admin-header">
            <div>
              <h1>{heading || 'Activity'}</h1>
              <p className="admin-date">Clock-in checks, presence checks, screenshots and away time for one person, one day at a time</p>
            </div>
            {headerActions}
          </div>
          <div className="admin-filters act-admin-filters">
            {picker}
            {dayNav}
          </div>
        </>
      ) : (
        <div className="page-header">
          <div>
            <h1>My Activity</h1>
            <p className="page-date">What was checked during your sessions. Only you and your admin can see this.</p>
          </div>
          {dayNav}
        </div>
      )}

      <div className="act-stats">
        <div className="act-stat"><span>Presence checks</span><strong>{checks.length ? `${passed}/${checks.length}` : '–'}</strong></div>
        <div className="act-stat"><span>Screenshots</span><strong>{shots.length}</strong></div>
        <div className="act-stat"><span>Away</span><strong>{Math.round(awayMinutes)} min</strong></div>
        <div className="act-stat"><span>Waiting for review</span><strong>{openFlags}</strong></div>
      </div>

      {loading && <p className="empty-state">Loading…</p>}
      {nothing && <p className={admin ? 'admin-empty' : 'empty-state'}>Nothing recorded on this day.</p>}

      {evidence.length > 0 && (
        <>
          <h2 className="reminders-subheading">Clock-in checks</h2>
          <div className="reminders-list">
            {evidence.map(e => (
              <div className="reminder-item" key={e.id}>
                {e.photo_path
                  ? <Thumb path={e.photo_path} alt="Clock-in photo" onOpen={setViewer} />
                  : <div className="reminder-icon"><ClockIcon width={18} height={18} /></div>}
                <div className="reminder-info">
                  <h3>Clocked in at {dateToHHMM(new Date(e.created_at))}</h3>
                  {(e.user_agent || '').startsWith('Clocked in by the admin') ? (
                    <p>{admin ? e.user_agent : 'Clocked in for you by your admin'}</p>
                  ) : (
                    <p>
                      <LaptopIcon width={12} height={12} /> {e.device_verified ? 'Laptop verified' : 'Laptop not verified'}
                      {' · '}{FACE_RESULT[e.face_result] || 'No face check'}
                      {e.face_result === 'match' && e.blink_passed === false ? ', eyes not seen closing' : ''}
                      {e.on_office_network === true ? ' · Office network' : e.on_office_network === false ? ' · Not on the office network' : ''}
                      {e.wifi_name ? ` · Wi-Fi “${e.wifi_name}”` : ''}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {checks.length > 0 && (
        <>
          <h2 className="reminders-subheading">Presence checks</h2>
          <div className="reminders-list">
            {checks.map(c => {
              // window over but not swept yet (runs every 5 min): already a miss
              const expired = c.result === 'pending' && new Date(c.expires_at) < new Date();
              const info = PRESENCE_RESULT[expired ? 'missed' : c.result] || PRESENCE_RESULT.pending;
              return (
                <div className="reminder-item" key={c.id}>
                  {c.photo_path
                    ? <Thumb path={c.photo_path} alt="Presence check photo" onOpen={setViewer} />
                    : <div className="reminder-icon"><FaceIcon width={18} height={18} /></div>}
                  <div className="reminder-info">
                    <h3>Asked at {dateToHHMM(new Date(c.due_at))}</h3>
                    <p>
                      {c.responded_at ? `Answered at ${dateToHHMM(new Date(c.responded_at))}` : 'Not answered'}
                      {c.answered_from ? ` · from the ${c.answered_from === 'desktop' ? 'desktop app' : 'web app'}` : ''}
                    </p>
                  </div>
                  <span className={`reminder-badge sec-badge-${info.tone}`}>{info.label}</span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {shots.length > 0 && (
        <>
          <h2 className="reminders-subheading">Screenshots</h2>
          <p className="page-date reminders-subnote">Taken by the desktop app. Deleted after 14 days.</p>
          <div className="act-shots">
            {shots.map(sh => (
              <div className="act-shot" key={sh.id}>
                <Thumb path={sh.path} bucket="screenshots" alt="Screenshot" onOpen={setViewer} />
                <span><ImageIcon width={12} height={12} /> {dateToHHMM(new Date(sh.taken_at))}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {away.length > 0 && (
        <>
          <h2 className="reminders-subheading">Away time</h2>
          <div className="reminders-list">
            {away.map(a => (
              <div className="reminder-item" key={a.id}>
                <div className="reminder-icon"><ClockIcon width={18} height={18} /></div>
                <div className="reminder-info">
                  <h3>{dateToHHMM(new Date(a.started_at))} – {a.ended_at ? dateToHHMM(new Date(a.ended_at)) : 'now'}</h3>
                  <p>
                    {a.type === 'locked' ? 'Screen locked' : a.type === 'contact_gap' ? 'No contact from the app' : 'No activity'}
                    {a.ended_at ? ` · ${Math.round((new Date(a.ended_at) - new Date(a.started_at)) / 60000)} min` : ''}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {flags.length > 0 && (
        <>
          <h2 className="reminders-subheading">{admin ? 'Flags' : 'Marked for your admin'}</h2>
          {!admin && <p className="page-date reminders-subnote">These aren’t penalties. Your admin looks at each one and accepts or declines it.</p>}
          <div className="reminders-list">
            {flags.map(f => {
              const info = FLAG_STATUS[f.status] || FLAG_STATUS.open;
              const summary = flagSummary(f);
              return (
                <div className="reminder-item" key={f.id}>
                  <div className="reminder-icon"><FlagIcon width={18} height={18} /></div>
                  <div className="reminder-info">
                    <h3>{FLAG_LABELS[f.type] || f.type}</h3>
                    <p>
                      {dateToHHMM(new Date(f.created_at))}
                      {summary ? ` · ${summary}` : ''}
                      {f.admin_note ? ` · Admin: ${f.admin_note}` : ''}
                    </p>
                  </div>
                  <span className={`reminder-badge sec-badge-${info.tone}`}>{info.label}</span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {viewer && (
        <div className="popup-overlay act-viewer" onClick={() => setViewer(null)}>
          <img src={viewer} alt="" />
          <button className="act-viewer-close" onClick={() => setViewer(null)} aria-label="Close"><XIcon width={18} height={18} /></button>
        </div>
      )}
    </div>
  );
}

export default MyActivity;
