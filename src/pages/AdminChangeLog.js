import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../supabase';
import { formatDayTime, formatClock } from '../lib/time';
import './Security.css';

// Change log: every admin change to a session, with what it was before and
// the reason. Saved by the database (log_record_change), so it can't be
// skipped from the page.

const FIELDS = [
  ['clock_in', 'Clock in', formatClock],
  ['clock_out', 'Clock out', formatClock],
  ['break_time', 'Breaks', v => v],
  ['hours_worked', 'Hours', v => v],
  ['location_status', 'Location', v => (v ? v[0].toUpperCase() + v.slice(1) : '–')],
  ['clock_in_at', 'Clock in', v => (v ? formatDayTime(v) : '–')],
  ['break_accum_seconds', 'Breaks', v => `${Math.round((v || 0) / 60)} min`]
];

function changes(entry) {
  if (entry.action === 'delete') return [['Session', 'deleted', '']];
  const before = entry.before || {};
  const after = entry.after || {};
  return FIELDS
    .filter(([key]) => key in after && String(before[key] ?? '') !== String(after[key] ?? ''))
    .map(([key, label, fmt]) => [label, fmt(before[key]) || '–', fmt(after[key]) || '–']);
}

function AdminChangeLog({ employees, headerActions }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [employeeFilter, setEmployeeFilter] = useState('all');

  const load = useCallback(async () => {
    const { data } = await supabase.from('change_log').select('*').order('created_at', { ascending: false }).limit(300);
    setEntries(data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  function employeeOf(entry) {
    if (entry.table_name === 'employee_status') return entry.record_id;
    return (entry.after || entry.before || {}).user_id;
  }

  function name(userId) {
    const e = employees.find(x => x.id === userId);
    return e ? (e.full_name || e.email) : 'Deleted account';
  }

  const shown = entries.filter(e => employeeFilter === 'all' || employeeOf(e) === employeeFilter);

  return (
    <>
      <div className="admin-header">
        <div>
          <h1>Change log</h1>
          <p className="admin-date">Every change made to someone’s session, what it was before, and why</p>
        </div>
        {headerActions}
      </div>

      <div className="admin-filters">
        <select className="admin-select" value={employeeFilter} onChange={e => setEmployeeFilter(e.target.value)}>
          <option value="all">All employees</option>
          {employees.map(e => <option key={e.id} value={e.id}>{e.full_name || e.email}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="admin-loading">Loading…</div>
      ) : shown.length === 0 ? (
        <div className="admin-empty"><p>No changes yet.</p></div>
      ) : (
        <div className="admin-table-card">
          <table className="admin-table">
            <thead>
              <tr><th>When</th><th>Employee</th><th>Session</th><th>What changed</th><th>Reason</th></tr>
            </thead>
            <tbody>
              {shown.map(entry => {
                const rec = entry.after || entry.before || {};
                const list = changes(entry);
                return (
                  <tr key={entry.id}>
                    <td className="log-when">{formatDayTime(entry.created_at)}</td>
                    <td>{name(employeeOf(entry))}</td>
                    <td>{entry.table_name === 'employee_status' ? 'Running session' : rec.date || '–'}</td>
                    <td>
                      {list.length === 0 ? <span className="admin-link-muted">No time or location change</span> : list.map(([label, from, to]) => (
                        <div className="log-change" key={label}>
                          <strong>{label}</strong> {from} <span>→</span> {to}
                        </div>
                      ))}
                    </td>
                    <td>{entry.reason || <span className="admin-link-muted">No reason given</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export default AdminChangeLog;
