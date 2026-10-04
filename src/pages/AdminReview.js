import { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase } from '../supabase';
import { signedPhotoUrl } from '../lib/security';
import { callAI } from '../lib/ai';
import AutoTextarea from '../components/AutoTextarea';
import { FLAG_LABELS, FLAG_STATUS, flagSummary } from '../lib/flags';
import { formatDayTime } from '../lib/time';
import { CheckCircleIcon, XIcon, FlagIcon } from '../icons';
import './Security.css';

// Review: every session something didn't add up on, grouped by session.
// Authorise = fine, counts as normal. Decline = the session isn't counted
// (same as declining an unauthorised location). Bulk select like Time Off.

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

function Photo({ path }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true;
    signedPhotoUrl(path).then(u => { if (alive) setUrl(u); });
    return () => { alive = false; };
  }, [path]);
  if (!path) return <div className="review-photo review-photo-empty">No photo</div>;
  return (
    <a className="review-photo" href={url || undefined} target="_blank" rel="noopener noreferrer">
      {url ? <img src={url} alt="Taken at clock-in" /> : null}
    </a>
  );
}

function AdminReview({ employees, headerActions, onOpenCountChange }) {
  const [flags, setFlags] = useState([]);
  const [evidence, setEvidence] = useState({});
  const [presence, setPresence] = useState({});
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('open');
  const [employeeFilter, setEmployeeFilter] = useState('all');
  const [selected, setSelected] = useState([]);
  const [notes, setNotes] = useState({});
  const [working, setWorking] = useState(null);
  const [drafting, setDrafting] = useState(null);       // `${key}:${decision}` while the AI writes
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const since = new Date(Date.now() - 45 * 86400000).toISOString();
    let query = supabase.from('session_flags').select('*').gte('created_at', since).order('created_at', { ascending: false });
    if (view === 'open') query = query.eq('status', 'open');
    if (view === 'decided') query = query.in('status', ['authorised', 'declined']);
    // things only recorded on the session (off network, away, ...) don't come here
    if (view === 'all') query = query.neq('status', 'noted');
    const { data } = await query;
    const list = data || [];
    setFlags(list);

    const sessionIds = [...new Set(list.map(f => f.session_id).filter(Boolean))];
    if (sessionIds.length) {
      const [ev, pc] = await Promise.all([
        supabase.from('clock_evidence').select('*').in('session_id', sessionIds),
        supabase.from('presence_checks').select('session_id, result, due_at').in('session_id', sessionIds)
      ]);
      const evMap = {};
      (ev.data || []).forEach(e => { evMap[e.session_id] = e; });
      const pcMap = {};
      (pc.data || []).forEach(p => {
        if (new Date(p.due_at) > new Date()) return;
        pcMap[p.session_id] = pcMap[p.session_id] || { passed: 0, total: 0 };
        pcMap[p.session_id].total += 1;
        if (p.result === 'passed') pcMap[p.session_id].passed += 1;
      });
      setEvidence(evMap);
      setPresence(pcMap);
    }
    setLoading(false);
  }, [view]);

  useEffect(() => {
    setLoading(true);
    setSelected([]);
    load();
  }, [load]);

  // new flags show up straight away
  useEffect(() => {
    const channel = supabase
      .channel('review-flags')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'session_flags' }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  // one group per session (flags without a session stand alone)
  const groups = useMemo(() => {
    const map = new Map();
    flags
      .filter(f => employeeFilter === 'all' || f.user_id === employeeFilter)
      .forEach(f => {
        const key = f.session_id || `flag-${f.id}`;
        if (!map.has(key)) map.set(key, { key, sessionId: f.session_id, userId: f.user_id, flags: [] });
        map.get(key).flags.push(f);
      });
    return [...map.values()].map(g => {
      g.flags.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3));
      g.first = g.flags.reduce((min, f) => (f.created_at < min ? f.created_at : min), g.flags[0].created_at);
      g.open = g.flags.filter(f => f.status === 'open');
      g.top = g.flags[0].severity;
      return g;
    }).sort((a, b) => (a.first < b.first ? 1 : -1));
  }, [flags, employeeFilter]);

  const openGroups = groups.filter(g => g.open.length);

  useEffect(() => {
    if (view === 'open' && employeeFilter === 'all' && onOpenCountChange) onOpenCountChange(openGroups.length);
  }, [openGroups.length, view, employeeFilter, onOpenCountChange]);

  function name(userId) {
    const e = employees.find(x => x.id === userId);
    return e ? (e.full_name || e.email) : 'Deleted account';
  }

  // AI writes the note from this session's flags; the admin can still edit it
  async function draftNote(g, decision) {
    setDrafting(`${g.key}:${decision}`);
    setError('');
    const ev = g.sessionId ? evidence[g.sessionId] : null;
    const pc = g.sessionId ? presence[g.sessionId] : null;
    try {
      const { message } = await callAI('review_note', {
        employeeName: name(g.userId),
        decision,
        when: ev ? `clocked in ${formatDayTime(ev.created_at)}` : `flagged ${formatDayTime(g.first)}`,
        flags: g.open.map(f => {
          const summary = flagSummary(f);
          return `${FLAG_LABELS[f.type] || f.type}${summary ? ` (${summary})` : ''}`;
        }),
        checks: [
          ev ? (ev.device_verified ? 'laptop verified' : 'laptop not verified') : null,
          ev?.face_result === 'match' ? 'face matched' : null,
          pc ? `presence checks passed ${pc.passed} of ${pc.total}` : null
        ].filter(Boolean)
      });
      setNotes(prev => ({ ...prev, [g.key]: (message || '').slice(0, 300) }));
    } catch (err) {
      setError(err.message || 'The note couldn’t be drafted. Type it instead.');
    }
    setDrafting(null);
  }

  async function decide(groupList, status) {
    setError('');
    for (const g of groupList) {
      const note = (notes[g.key] || '').trim() || null;
      const ids = g.open.map(f => f.id);
      if (!ids.length) continue;
      const { error: flagError } = await supabase.from('session_flags')
        .update({ status, decided_at: new Date().toISOString(), admin_note: note })
        .in('id', ids);
      if (flagError) { setError(flagError.message); return; }

      // declined = not counted, on the saved session or the live one
      if (status === 'declined' && g.sessionId) {
        const reason = `Declined on Review: ${note || g.open.map(f => FLAG_LABELS[f.type] || f.type).join(', ')}`;
        const { data: recs } = await supabase.from('records').select('id').eq('session_id', g.sessionId);
        if (recs && recs.length) {
          await supabase.from('records').update({ location_status: 'declined', edit_reason: reason }).eq('session_id', g.sessionId);
        } else {
          await supabase.from('employee_status').update({ location_status: 'declined' })
            .eq('user_id', g.userId).eq('session_id', g.sessionId);
        }
      }
    }
  }

  async function handleOne(g, status) {
    setWorking(g.key);
    await decide([g], status);
    setWorking(null);
    load();
  }

  async function handleBulk(status) {
    setWorking('bulk');
    await decide(openGroups.filter(g => selected.includes(g.key)), status);
    setSelected([]);
    setWorking(null);
    load();
  }

  const allSelected = openGroups.length > 0 && openGroups.every(g => selected.includes(g.key));
  const usersWithFlags = [...new Set(flags.map(f => f.user_id))];

  return (
    <>
      <div className="admin-header">
        <div>
          <h1>Review</h1>
          <p className="admin-date">Clock-ins and presence checks where the face didn’t match. Look at the photos, then authorise, or decline so the session doesn’t count.</p>
        </div>
        {headerActions}
      </div>

      <div className="admin-filters">
        <select className="admin-select" value={view} onChange={e => setView(e.target.value)}>
          <option value="open">Waiting for review</option>
          <option value="decided">Decided</option>
          <option value="all">All (last 45 days)</option>
        </select>
        <select className="admin-select" value={employeeFilter} onChange={e => setEmployeeFilter(e.target.value)}>
          <option value="all">All employees</option>
          {usersWithFlags.map(id => <option key={id} value={id}>{name(id)}</option>)}
        </select>
      </div>

      {selected.length > 0 && (
        <div className="timeoff-bulk-bar">
          <span>{selected.length} selected</span>
          <div className="timeoff-bulk-actions">
            <button className="admin-action-btn admin-action-in" onClick={() => handleBulk('authorised')} disabled={!!working}>
              <CheckCircleIcon width={15} height={15} /> {working === 'bulk' ? 'Working…' : 'Authorise selected'}
            </button>
            <button className="admin-action-btn admin-action-reject" onClick={() => handleBulk('declined')} disabled={!!working}>
              <XIcon width={15} height={15} /> {working === 'bulk' ? 'Working…' : 'Decline selected'}
            </button>
          </div>
        </div>
      )}
      {error && <p className="admin-confirm-error">{error}</p>}

      {loading ? (
        <div className="admin-loading">Loading…</div>
      ) : groups.length === 0 ? (
        <div className="admin-empty"><p>{view === 'open' ? 'Nothing waiting for review.' : 'Nothing here.'}</p></div>
      ) : (
        <div className="admin-table-card timeoff-admin-card">
          {openGroups.length > 0 && (
            <div className="timeoff-admin-header-row">
              <label className="timeoff-select-all">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? [] : openGroups.map(g => g.key))}
                />
                Select all waiting
              </label>
            </div>
          )}
          <div className="timeoff-admin-list">
            {groups.map(g => {
              const ev = g.sessionId ? evidence[g.sessionId] : null;
              const pc = g.sessionId ? presence[g.sessionId] : null;
              const decided = !g.open.length;
              const status = decided ? FLAG_STATUS[g.flags[0].status] : null;
              return (
                <div className="timeoff-admin-row review-row" key={g.key}>
                  <div className="timeoff-admin-checkbox">
                    <input
                      type="checkbox"
                      disabled={decided}
                      checked={selected.includes(g.key)}
                      onChange={() => setSelected(prev => prev.includes(g.key) ? prev.filter(k => k !== g.key) : [...prev, g.key])}
                      aria-label={`Select ${name(g.userId)}`}
                    />
                  </div>
                  <Photo path={ev?.photo_path} />
                  <div className="timeoff-admin-main">
                    <p className="timeoff-history-type">
                      <span className={`review-dot review-dot-${g.top}`} /> {name(g.userId)}
                    </p>
                    <p className="timeoff-history-dates">
                      {ev ? `Clocked in ${formatDayTime(ev.created_at)}` : `Flagged ${formatDayTime(g.first)}`}
                      {ev ? ` · ${ev.device_verified ? 'laptop verified' : 'laptop not verified'}` : ''}
                      {ev?.face_result === 'match' ? ' · face matched' : ''}
                      {pc ? ` · presence ${pc.passed}/${pc.total}` : ''}
                    </p>
                    <div className="review-chips">
                      {g.flags.map(f => {
                        const summary = flagSummary(f);
                        return (
                          <span className={`review-chip review-chip-${f.severity}`} key={f.id} title={summary || undefined}>
                            <FlagIcon width={12} height={12} /> {FLAG_LABELS[f.type] || f.type}
                            {summary ? <em> · {summary}</em> : null}
                          </span>
                        );
                      })}
                    </div>
                    {!decided && (
                      <>
                        <AutoTextarea
                          className="admin-dept-input review-note"
                          placeholder="Note (optional, the employee sees it)"
                          value={notes[g.key] || ''}
                          maxLength={300}
                          maxRows={5}
                          onChange={e => setNotes(prev => ({ ...prev, [g.key]: e.target.value }))}
                        />
                        <div className="review-draft">
                          {['authorised', 'declined'].map(d => (
                            <button key={d} type="button" className="review-draft-btn" onClick={() => draftNote(g, d)} disabled={!!drafting || !!working}>
                              {drafting === `${g.key}:${d}` ? 'Writing…' : d === 'authorised' ? 'Draft accept note' : 'Draft decline note'}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                    {decided && g.flags[0].admin_note && (
                      <p className="timeoff-history-reason">Note: {g.flags[0].admin_note}</p>
                    )}
                  </div>
                  {decided ? (
                    <span className={`reminder-badge sec-badge-${status.tone}`}>{status.label}</span>
                  ) : (
                    <div className="timeoff-admin-actions">
                      {working === g.key ? (
                        <span className="admin-link-muted">Working…</span>
                      ) : (
                        <>
                          <button className="admin-link-btn" onClick={() => handleOne(g, 'authorised')} disabled={!!working}>Authorise</button>
                          <button className="admin-link-btn admin-link-danger" onClick={() => handleOne(g, 'declined')} disabled={!!working}>Decline</button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

export default AdminReview;
