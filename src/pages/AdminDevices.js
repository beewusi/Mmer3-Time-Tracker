import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../supabase';
import { signedPhotoUrl } from '../lib/security';
import { formatDayTime, formatAgo } from '../lib/time';
import { LaptopIcon, FaceIcon, CheckCircleIcon } from '../icons';
import './Security.css';

// Devices: approve work laptops and face photos. Waiting ones first, with
// "approve all" for the first week when everyone registers at once.

const STATUS_TEXT = { pending: 'Waiting', approved: 'Approved', rejected: 'Not accepted', revoked: 'Removed', withdrawn: 'Consent withdrawn' };
const STATUS_TONE = { pending: 'pending', approved: 'active', rejected: 'danger', revoked: 'neutral', withdrawn: 'neutral' };

function FacePhoto({ path }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true;
    signedPhotoUrl(path).then(u => { if (alive) setUrl(u); });
    return () => { alive = false; };
  }, [path]);
  return (
    <a className="review-photo" href={url || undefined} target="_blank" rel="noopener noreferrer">
      {url ? <img src={url} alt="Face setup" /> : null}
    </a>
  );
}

function AdminDevices({ employees, headerActions, onPendingCountChange }) {
  const [devices, setDevices] = useState([]);
  const [faces, setFaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [d, f] = await Promise.all([
      supabase.from('devices').select('id, user_id, label, status, created_at, approved_at, last_used_at, synced').neq('status', 'revoked').order('created_at', { ascending: false }),
      supabase.from('face_profiles').select('user_id, status, photo_path, consent_at, updated_at, approved_at').order('updated_at', { ascending: false })
    ]);
    setDevices(d.data || []);
    setFaces(f.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const pendingDevices = devices.filter(d => d.status === 'pending');
  const pendingFaces = faces.filter(f => f.status === 'pending');

  useEffect(() => {
    if (!loading && onPendingCountChange) onPendingCountChange(pendingDevices.length + pendingFaces.length);
  }, [loading, pendingDevices.length, pendingFaces.length, onPendingCountChange]);

  function name(userId) {
    const e = employees.find(x => x.id === userId);
    return e ? (e.full_name || e.email) : 'Deleted account';
  }

  async function run(key, fn) {
    setError('');
    setWorking(key);
    const { error: err } = await fn();
    if (err) setError(err.message);
    setWorking(null);
    load();
  }

  const setDevice = (ids, status) => run(ids.length > 1 ? 'all-devices' : ids[0], () =>
    status === 'revoked'
      ? supabase.from('devices').delete().in('id', ids)
      : supabase.from('devices').update({ status, approved_at: status === 'approved' ? new Date().toISOString() : null }).in('id', ids));

  // only the version on screen: if the employee retook their face meanwhile,
  // updated_at has changed and nothing is approved
  const setFace = (list, status) => run(list.length > 1 ? 'all-faces' : `face-${list[0].user_id}`, async () => {
    let changed = 0;
    for (const f of list) {
      // eslint-disable-next-line no-await-in-loop
      const { data, error } = await supabase.from('face_profiles')
        .update({ status, approved_at: status === 'approved' ? new Date().toISOString() : null })
        .eq('user_id', f.user_id).eq('updated_at', f.updated_at).select('user_id');
      if (error) return { error };
      changed += (data || []).length;
    }
    if (changed < list.length) return { error: { message: 'A face was retaken while this page was open. Look at the new photo before approving.' } };
    return { error: null };
  });

  // how many laptops each person has (more than one is worth a look)
  const perUser = devices.reduce((m, d) => ({ ...m, [d.user_id]: (m[d.user_id] || 0) + 1 }), {});
  const withoutLaptop = employees.filter(e => !devices.some(d => d.user_id === e.id && d.status === 'approved'));
  const withoutFace = employees.filter(e => !faces.some(f => f.user_id === e.id && f.status === 'approved'));

  return (
    <>
      <div className="admin-header">
        <div>
          <h1>Devices</h1>
          <p className="admin-date">Approve work laptops and face photos before they’re used at clock-in</p>
        </div>
        {headerActions}
      </div>

      {error && <p className="admin-confirm-error">{error}</p>}

      <div className="admin-stats sec-admin-stats">
        <div className="admin-stat-card"><p className="admin-stat-label">Laptops waiting</p><p className={`admin-stat-value ${pendingDevices.length ? 'stat-warning' : 'stat-muted'}`}>{pendingDevices.length}</p></div>
        <div className="admin-stat-card"><p className="admin-stat-label">Faces waiting</p><p className={`admin-stat-value ${pendingFaces.length ? 'stat-warning' : 'stat-muted'}`}>{pendingFaces.length}</p></div>
        <div className="admin-stat-card"><p className="admin-stat-label">No approved laptop</p><p className="admin-stat-value stat-neutral">{withoutLaptop.length}</p></div>
        <div className="admin-stat-card"><p className="admin-stat-label">No face check</p><p className="admin-stat-value stat-neutral">{withoutFace.length}</p></div>
      </div>

      {/* ---------- laptops ---------- */}
      <div className="sec-admin-section-head">
        <h2 className="reminders-subheading">Work laptops</h2>
        {pendingDevices.length > 1 && (
          <button className="admin-action-btn admin-action-in sec-admin-all" onClick={() => setDevice(pendingDevices.map(d => d.id), 'approved')} disabled={!!working}>
            <CheckCircleIcon width={15} height={15} /> {working === 'all-devices' ? 'Working…' : `Approve all ${pendingDevices.length}`}
          </button>
        )}
      </div>
      {loading ? (
        <div className="admin-loading">Loading…</div>
      ) : devices.length === 0 ? (
        <div className="admin-empty"><p>No laptops registered yet. Employees register theirs from Devices &amp; Security.</p></div>
      ) : (
        <div className="admin-table-card">
          <table className="admin-table">
            <thead>
              <tr><th>Employee</th><th>Laptop</th><th>Registered</th><th>Last used</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {[...pendingDevices, ...devices.filter(d => d.status !== 'pending')].map(d => (
                <tr key={d.id}>
                  <td>{name(d.user_id)}{perUser[d.user_id] > 1 && <span className="sec-tag">{perUser[d.user_id]} laptops</span>}</td>
                  <td>
                    <LaptopIcon width={14} height={14} className="sec-cell-icon" /> {d.label || 'Work laptop'}
                    {d.synced && <span className="sec-tag sec-tag-warn" title="The passkey was also saved to a phone or another device through iCloud or Google">Synced</span>}
                  </td>
                  <td>{formatDayTime(d.created_at)}</td>
                  <td>{d.last_used_at ? formatAgo(d.last_used_at) : '–'}</td>
                  <td><span className={`reminder-badge sec-badge-${STATUS_TONE[d.status]}`}>{STATUS_TEXT[d.status]}</span></td>
                  <td>
                    <div className="admin-table-actions">
                      {working === d.id ? <span className="admin-link-muted">Working…</span> : (
                        <>
                          {d.status === 'pending' && <button className="admin-link-btn" onClick={() => setDevice([d.id], 'approved')}>Approve</button>}
                          <button className="admin-link-btn admin-link-danger" onClick={() => setDevice([d.id], 'revoked')}>Remove</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---------- faces ---------- */}
      <div className="sec-admin-section-head">
        <h2 className="reminders-subheading">Face check photos</h2>
        {pendingFaces.length > 1 && (
          <button className="admin-action-btn admin-action-in sec-admin-all" onClick={() => setFace(pendingFaces, 'approved')} disabled={!!working}>
            <CheckCircleIcon width={15} height={15} /> {working === 'all-faces' ? 'Working…' : `Approve all ${pendingFaces.length}`}
          </button>
        )}
      </div>
      <p className="admin-date sec-admin-note">Check the photo is clearly the employee, alone, facing the camera. Only approved faces are used at clock-in.</p>
      {loading ? null : faces.length === 0 ? (
        <div className="admin-empty"><p>No faces set up yet.</p></div>
      ) : (
        <div className="admin-table-card timeoff-admin-card">
          <div className="timeoff-admin-list">
            {[...pendingFaces, ...faces.filter(f => f.status !== 'pending')].map(f => (
              <div className="timeoff-admin-row review-row" key={f.user_id}>
                {f.photo_path ? <FacePhoto path={f.photo_path} /> : <div className="review-photo review-photo-empty">Deleted</div>}
                <div className="timeoff-admin-main">
                  <p className="timeoff-history-type"><FaceIcon width={13} height={13} className="sec-cell-icon" /> {name(f.user_id)}</p>
                  <p className="timeoff-history-dates">
                    Set up {formatDayTime(f.updated_at)} · consent {formatDayTime(f.consent_at)}
                    {f.approved_at ? ` · approved ${formatDayTime(f.approved_at)}` : ''}
                  </p>
                </div>
                <span className={`reminder-badge sec-badge-${STATUS_TONE[f.status]}`}>{STATUS_TEXT[f.status]}</span>
                <div className="timeoff-admin-actions">
                  {working === `face-${f.user_id}` ? <span className="admin-link-muted">Working…</span> : (
                    <>
                      {f.status !== 'approved' && f.status !== 'withdrawn' && <button className="admin-link-btn" onClick={() => setFace([f], 'approved')}>Approve</button>}
                      {f.status !== 'rejected' && f.status !== 'withdrawn' && <button className="admin-link-btn admin-link-danger" onClick={() => setFace([f], 'rejected')}>Reject</button>}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

export default AdminDevices;
