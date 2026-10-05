import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../supabase';
import MyActivity from './MyActivity';
import { formatAgo, dateToHHMM } from '../lib/time';
import { FLAG_LABELS } from '../lib/flags';
import './Security.css';

// Activity: everyone who worked on a day, with the ones worth a look at the
// top (missed checks, long away time, anything flagged), then the full day
// for one person (same view the employee gets on My Activity).

const CONTACT_LATE_MIN = 15;
const LONG_AWAY_MIN = 30;

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

function AdminActivity({ employees, employeeStatuses, headerActions, initialUserId }) {
  const [userId, setUserId] = useState(initialUserId || '');
  const [day, setDay] = useState(new Date());
  const [beats, setBeats] = useState({});
  const [rows, setRows] = useState({});            // user id -> what happened that day
  const [loading, setLoading] = useState(true);
  const isToday = sameDay(day, new Date());

  const load = useCallback(async () => {
    const [from, to] = dayBounds(day);
    const now = new Date().toISOString();
    const [hb, ev, pc, ae, sc, fl] = await Promise.all([
      supabase.from('heartbeats').select('*'),
      supabase.from('clock_evidence').select('user_id, created_at').eq('kind', 'clock_in').gte('created_at', from).lt('created_at', to),
      supabase.from('presence_checks').select('user_id, result').gte('due_at', from).lt('due_at', to).lte('due_at', now),
      supabase.from('activity_events').select('user_id, started_at, ended_at').gte('started_at', from).lt('started_at', to),
      supabase.from('screenshots').select('user_id').gte('taken_at', from).lt('taken_at', to),
      supabase.from('session_flags').select('user_id, type').gte('created_at', from).lt('created_at', to)
    ]);
    const b = {};
    (hb.data || []).forEach(h => { b[h.user_id] = h; });
    setBeats(b);

    const r = {};
    const row = id => (r[id] = r[id] || { firstIn: null, passed: 0, total: 0, missed: 0, awayMin: 0, shots: 0, flags: [] });
    (ev.data || []).forEach(e => {
      const x = row(e.user_id);
      if (!x.firstIn || e.created_at < x.firstIn) x.firstIn = e.created_at;
    });
    (pc.data || []).forEach(c => {
      const x = row(c.user_id);
      x.total += 1;
      if (c.result === 'passed') x.passed += 1;
      if (c.result === 'missed' || c.result === 'failed') x.missed += 1;
    });
    (ae.data || []).forEach(a => {
      const endAt = a.ended_at ? new Date(a.ended_at) : (isToday ? new Date() : null);
      if (endAt) row(a.user_id).awayMin += Math.max(0, (endAt - new Date(a.started_at)) / 60000);
    });
    (sc.data || []).forEach(x => { row(x.user_id).shots += 1; });
    (fl.data || []).forEach(f => {
      const x = row(f.user_id);
      if (!x.flags.includes(f.type)) x.flags.push(f.type);
    });
    setRows(r);
    setLoading(false);
  }, [day, isToday]);

  useEffect(() => {
    setLoading(true);
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (initialUserId) setUserId(initialUserId);
  }, [initialUserId]);

  const liveStatus = id => {
    const s = employeeStatuses[id];
    if (!isToday || !s) return null;
    if (s.status === 'clocked_in') return 'Working';
    if (s.status === 'on_break') return s.paused_for_check ? 'Paused (missed check)' : 'On break';
    return null;
  };

  // who worked that day: clocked in that day, or still working now
  const people = employees
    .filter(e => (rows[e.id] && (rows[e.id].firstIn || rows[e.id].total)) || liveStatus(e.id))
    .map(e => {
      const x = rows[e.id] || { firstIn: null, passed: 0, total: 0, missed: 0, awayMin: 0, shots: 0, flags: [] };
      const h = beats[e.id];
      const live = liveStatus(e.id);
      const desktopOn = !!h?.desktop_seen_at && Date.now() - new Date(h.desktop_seen_at).getTime() < CONTACT_LATE_MIN * 60000;
      const notes = x.flags.map(t => FLAG_LABELS[t] || t);
      if (live && !desktopOn) notes.push('Desktop app not running');
      if (x.awayMin >= LONG_AWAY_MIN && !x.flags.includes('away') && !x.flags.includes('contact_gap')) notes.push('Long away time');
      const attention = x.missed > 0 || x.awayMin >= LONG_AWAY_MIN || x.flags.some(t => t !== 'device_pending') || (live && !desktopOn);
      return { e, x, h, live, desktopOn, notes, attention };
    })
    .sort((a, b) => (a.attention !== b.attention ? (a.attention ? -1 : 1) : ((a.x.firstIn || '') < (b.x.firstIn || '') ? 1 : -1)));
  const needLook = people.filter(p => p.attention).length;

  function shiftDay(n) {
    const d = new Date(day);
    d.setDate(d.getDate() + n);
    if (d > new Date()) return;
    setDay(d);
  }

  function contact(h) {
    const last = [h?.web_seen_at, h?.desktop_seen_at].filter(Boolean).sort().pop();
    if (!last) return { text: 'no contact yet', late: true };
    const mins = (Date.now() - new Date(last).getTime()) / 60000;
    return { text: formatAgo(last), late: mins > CONTACT_LATE_MIN };
  }

  const picker = (
    <select className="admin-select" value={userId} onChange={e => setUserId(e.target.value)}>
      <option value="">Pick an employee…</option>
      {employees.map(e => <option key={e.id} value={e.id}>{e.full_name || e.email}</option>)}
    </select>
  );

  return (
    <>
      {!userId && (
        <div className="admin-header">
          <div>
            <h1>Activity</h1>
            <p className="admin-date">Everyone who worked that day. Anyone worth a look is at the top; click a name for their full day.</p>
          </div>
          {headerActions}
        </div>
      )}

      {!userId && (
        <>
          <div className="admin-filters sec-activity-filters">
            <div className="timesheet-month-nav act-day-nav">
              <button className="timesheet-month-btn" onClick={() => shiftDay(-1)} aria-label="Previous day">‹</button>
              <span className="timesheet-month-label">{isToday ? 'Today' : day.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
              <button className="timesheet-month-btn" onClick={() => shiftDay(1)} disabled={isToday} aria-label="Next day">›</button>
            </div>
            {picker}
          </div>
          {loading ? (
            <div className="admin-empty"><p>Loading…</p></div>
          ) : people.length === 0 ? (
            <div className="admin-empty"><p>{isToday ? 'Nobody has worked yet today.' : 'Nobody worked that day.'}</p></div>
          ) : (
            <>
              <p className="admin-date sec-activity-summary">
                {people.length} {people.length === 1 ? 'person' : 'people'} · {needLook ? `${needLook} worth a look` : 'nothing unusual'}
              </p>
              <div className="admin-table-card">
                <table className="admin-table">
                  <thead>
                    <tr><th>Employee</th><th>Clocked in</th><th>Now</th><th>Presence checks</th><th>Away</th><th>Screenshots</th><th>Worth a look</th></tr>
                  </thead>
                  <tbody>
                    {people.map(({ e, x, h, live, desktopOn, notes, attention }) => {
                      const c = contact(h);
                      return (
                        <tr key={e.id} className={`clickable-row ${attention ? 'sec-row-attention' : ''}`} onClick={() => setUserId(e.id)}>
                          <td>{e.full_name || e.email}</td>
                          <td>{x.firstIn ? dateToHHMM(new Date(x.firstIn)) : '–'}</td>
                          <td>
                            {live ? (
                              <>
                                {live}
                                <span className={`sec-activity-sub ${c.late ? 'cell-warning' : ''}`}>
                                  {desktopOn ? 'Desktop app running' : `Last contact ${c.text}`}
                                </span>
                              </>
                            ) : 'Clocked out'}
                          </td>
                          <td className={x.missed ? 'cell-warning' : ''}>
                            {x.total ? `${x.passed}/${x.total} passed` : '–'}
                          </td>
                          <td className={x.awayMin >= LONG_AWAY_MIN ? 'cell-warning' : ''}>{x.awayMin >= 1 ? `${Math.round(x.awayMin)} min` : '–'}</td>
                          <td>{x.shots || '–'}</td>
                          <td className={attention ? 'cell-warning' : ''}>{notes.length ? notes.join(' · ') : '–'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {userId && (
        <>
          <button className="admin-link-btn sec-back" onClick={() => setUserId('')}>‹ Everyone</button>
          <MyActivity
            key={userId}
            userId={userId}
            admin
            heading={(employees.find(e => e.id === userId) || {}).full_name || 'Activity'}
            headerActions={headerActions}
            picker={picker}
          />
        </>
      )}
    </>
  );
}

export default AdminActivity;
