import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../supabase';
import MyActivity from './MyActivity';
import { formatAgo } from '../lib/time';
import './Security.css';

// Activity: who's working right now and whether the app can still see them,
// then the full day for one person (same view the employee gets on My Activity).

const CONTACT_LATE_MIN = 15;

function AdminActivity({ employees, employeeStatuses, headerActions, initialUserId }) {
  const [userId, setUserId] = useState(initialUserId || '');
  const [beats, setBeats] = useState({});
  const [today, setToday] = useState({});

  const load = useCallback(async () => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const [hb, pc, fl] = await Promise.all([
      supabase.from('heartbeats').select('*'),
      supabase.from('presence_checks').select('user_id, result, due_at').gte('due_at', start.toISOString()).lte('due_at', new Date().toISOString()),
      supabase.from('session_flags').select('user_id, status').eq('status', 'open')
    ]);
    const b = {};
    (hb.data || []).forEach(h => { b[h.user_id] = h; });
    setBeats(b);
    const t = {};
    (pc.data || []).forEach(p => {
      t[p.user_id] = t[p.user_id] || { passed: 0, total: 0, flags: 0 };
      t[p.user_id].total += 1;
      if (p.result === 'passed') t[p.user_id].passed += 1;
    });
    (fl.data || []).forEach(f => {
      t[f.user_id] = t[f.user_id] || { passed: 0, total: 0, flags: 0 };
      t[f.user_id].flags += 1;
    });
    setToday(t);
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (initialUserId) setUserId(initialUserId);
  }, [initialUserId]);

  const working = employees.filter(e => {
    const s = employeeStatuses[e.id]?.status;
    return s === 'clocked_in' || s === 'on_break';
  });

  function contact(e) {
    const h = beats[e.id];
    const last = [h?.web_seen_at, h?.desktop_seen_at].filter(Boolean).sort().pop();
    if (!last) return { text: 'No contact yet', late: true };
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
            <p className="admin-date">Who’s clocked in now, when the app last heard from them, and today’s presence checks</p>
          </div>
          {headerActions}
        </div>
      )}

      {!userId && (
        <>
          <div className="admin-filters">{picker}</div>
          {working.length === 0 ? (
            <div className="admin-empty"><p>Nobody is clocked in right now.</p></div>
          ) : (
            <div className="admin-table-card">
              <table className="admin-table">
                <thead>
                  <tr><th>Employee</th><th>Status</th><th>Last contact</th><th>Desktop app</th><th>Computer</th><th>Presence today</th><th>Waiting for review</th></tr>
                </thead>
                <tbody>
                  {working.map(e => {
                    const h = beats[e.id];
                    const c = contact(e);
                    const t = today[e.id] || { passed: 0, total: 0, flags: 0 };
                    const desktopOn = h?.desktop_seen_at && Date.now() - new Date(h.desktop_seen_at).getTime() < CONTACT_LATE_MIN * 60000;
                    return (
                      <tr key={e.id} className="clickable-row" onClick={() => setUserId(e.id)}>
                        <td>{e.full_name || e.email}</td>
                        <td>{employeeStatuses[e.id]?.status === 'on_break' ? 'On break' : 'Working'}</td>
                        <td className={c.late ? 'cell-warning' : ''}>{c.text}</td>
                        <td>
                          <span className={`reminder-badge sec-badge-${desktopOn ? 'active' : 'neutral'}`}>{desktopOn ? 'Running' : 'Not running'}</span>
                        </td>
                        <td>{h?.idle_state === 'locked' ? 'Locked' : h?.idle_state === 'idle' ? 'Idle' : h ? 'In use' : '–'}</td>
                        <td>{t.total ? `${t.passed}/${t.total}` : '–'}</td>
                        <td className={t.flags ? 'cell-warning' : ''}>{t.flags || '–'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {userId && (
        <>
          <button className="admin-link-btn sec-back" onClick={() => setUserId('')}>‹ Everyone working now</button>
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
