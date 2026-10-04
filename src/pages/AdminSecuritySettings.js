import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../supabase';
import { callClockCheck, loadSecuritySettings } from '../lib/security';
import { formatDayTime } from '../lib/time';
import { WifiIcon, LaptopIcon, FaceIcon, ClockIcon, AlertIcon } from '../icons';
import './Security.css';

// Clock-in check settings on the admin Settings page: office networks
// (+ "network down today"), and the switches/numbers for the checks.

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function AdminSecuritySettings() {
  const [settings, setSettings] = useState(null);
  const [networks, setNetworks] = useState([]);
  const [ip, setIp] = useState('');
  const [recent, setRecent] = useState([]);       // addresses people clocked in from that aren't the office
  const [renaming, setRenaming] = useState(null); // { id, value }
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const [s, n, e, p] = await Promise.all([
      loadSecuritySettings(),
      supabase.from('office_networks').select('*').order('created_at'),
      supabase.from('clock_evidence').select('user_id, ip, wifi_name, created_at').not('ip', 'is', null).gte('created_at', since),
      supabase.from('profiles').select('id, full_name, email')
    ]);
    const nets = n.data || [];
    setSettings(s);
    setNetworks(nets);
    // one line per address: Wi-Fi name if the desktop app gave one, who, when
    const names = new Map((p.data || []).map(x => [x.id, x.full_name || x.email]));
    const byIp = new Map();
    (e.data || []).forEach(r => {
      if (nets.some(x => x.ip === r.ip)) return;
      const entry = byIp.get(r.ip) || { ip: r.ip, wifi: null, people: [], last: r.created_at };
      const who = names.get(r.user_id) || 'Someone';
      if (!entry.people.includes(who)) entry.people.push(who);
      if (r.created_at >= entry.last) {
        entry.last = r.created_at;
        if (r.wifi_name) entry.wifi = r.wifi_name;
      }
      if (!entry.wifi && r.wifi_name) entry.wifi = r.wifi_name;
      byIp.set(r.ip, entry);
    });
    setRecent([...byIp.values()].sort((x, y) => (x.last < y.last ? 1 : -1)).slice(0, 5));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save(patch) {
    setError('');
    setSettings(prev => ({ ...prev, ...patch }));
    const { error: err } = await supabase.from('security_settings')
      .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', 1);
    if (err) {
      setError(err.message);
      load();
    }
  }

  // name for a new network: the Wi-Fi name the desktop app saw on that
  // address (or on this computer), else just "Office"
  async function nameFor(address, useMine) {
    const { data } = await supabase.from('clock_evidence').select('wifi_name')
      .eq('ip', address).not('wifi_name', 'is', null).order('created_at', { ascending: false }).limit(1);
    if (data?.[0]?.wifi_name) return data[0].wifi_name.slice(0, 40);
    if (useMine) {
      const { data: { user } } = await supabase.auth.getUser();
      const { data: beat } = await supabase.from('heartbeats').select('wifi_name').eq('user_id', user?.id).maybeSingle();
      if (beat?.wifi_name) return beat.wifi_name.slice(0, 40);
    }
    return 'Office';
  }

  async function addNetwork(how, given) {
    setError('');
    setNote('');
    setBusy(how === 'recent' ? given.ip : how);
    try {
      let address = how === 'recent' ? given.ip : ip.trim();
      if (how === 'mine') {
        const res = await callClockCheck('my-ip');
        address = res?.ip || '';
        if (!address) throw new Error('Couldn’t read this connection’s address.');
      }
      if (!/^[0-9a-fA-F:.]{3,45}$/.test(address)) throw new Error('That doesn’t look like an internet address.');
      if (networks.some(n => n.ip === address)) throw new Error(`${address} is already on the list.`);
      const label = (how === 'recent' && given.wifi) ? given.wifi.slice(0, 40) : await nameFor(address, how === 'mine');
      const { data: added, error: err } = await supabase.from('office_networks')
        .insert({ label, ip: address }).select('id').single();
      if (err) throw err;
      // routers the desktop app reported on this address lately belong to it
      const { data: seenRouters } = await supabase.from('clock_evidence').select('wifi_router, wifi_name')
        .eq('ip', address).not('wifi_router', 'is', null)
        .gte('created_at', new Date(Date.now() - 30 * 86400000).toISOString());
      const rows = [...new Map((seenRouters || []).map(r => [r.wifi_router, r])).values()]
        .map(r => ({ router: r.wifi_router, network_id: added.id, label: r.wifi_name || label }));
      if (rows.length) {
        await supabase.from('office_routers').upsert(rows, { onConflict: 'router', ignoreDuplicates: true });
      }
      setNote(`Added ${label} (${address}).`);
      setIp('');
      load();
    } catch (err) {
      setError(err.message);
    }
    setBusy('');
  }

  async function saveName() {
    const value = renaming.value.trim();
    if (!value) return;
    setBusy(renaming.id);
    const { error: err } = await supabase.from('office_networks').update({ label: value.slice(0, 40) }).eq('id', renaming.id);
    setBusy('');
    if (err) setError(err.message);
    setRenaming(null);
    load();
  }

  async function removeNetwork(id) {
    setBusy(id);
    await supabase.from('office_networks').delete().eq('id', id);
    setBusy('');
    load();
  }

  if (!settings) return null;
  const outageToday = settings.network_outage_on === todayLocal();

  return (
    <>
      <h2 className="reminders-subheading">Clock-in checks</h2>
      <p className="admin-date sec-admin-note">What each person needs before they can clock in, and the checks during a session.</p>
      <div className="reminders-list">
        <div className="reminder-item">
          <div className="reminder-icon"><LaptopIcon width={18} height={18} /></div>
          <div className="reminder-info">
            <h3>Registered laptop</h3>
            <p>Clocking in needs a registered work laptop (Windows Hello / Touch ID). Off: anyone can clock in from any computer.</p>
          </div>
          <label className="toggle-switch">
            <input type="checkbox" checked={!!settings.require_registered_device} onChange={e => save({ require_registered_device: e.target.checked })} />
            <span className="toggle-slider"></span>
          </label>
        </div>
        <div className="reminder-item">
          <div className="reminder-icon"><FaceIcon width={18} height={18} /></div>
          <div className="reminder-info">
            <h3>Face check</h3>
            <p>Camera check with a blink at clock-in and during presence checks. Needed to clock in while on.</p>
          </div>
          <label className="toggle-switch">
            <input type="checkbox" checked={!!settings.face_check_enabled} onChange={e => save({ face_check_enabled: e.target.checked })} />
            <span className="toggle-slider"></span>
          </label>
        </div>
        <div className="reminder-item">
          <div className="reminder-icon"><ClockIcon width={18} height={18} /></div>
          <div className="reminder-info">
            <h3>Presence checks</h3>
            <p>Random times in each session. Takes effect from the next clock-in.</p>
          </div>
          <div className="sec-number-fields">
            <label>
              <select className="admin-select" value={settings.presence_checks_per_session} onChange={e => save({ presence_checks_per_session: Number(e.target.value) })}>
                {[0, 1, 2, 3, 4, 5, 6, 8].map(n => <option key={n} value={n}>{n === 0 ? 'Off' : `${n} a session`}</option>)}
              </select>
            </label>
            <label>
              <select className="admin-select" value={settings.presence_window_minutes} onChange={e => save({ presence_window_minutes: Number(e.target.value) })}>
                {[3, 5, 10, 15].map(n => <option key={n} value={n}>{n} min to answer</option>)}
              </select>
            </label>
          </div>
        </div>
        <div className="reminder-item">
          <div className="reminder-icon"><ClockIcon width={18} height={18} /></div>
          <div className="reminder-info">
            <h3>Screenshots</h3>
            <p>Taken by the desktop app, only while clocked in. Kept 14 days.</p>
          </div>
          <select className="admin-select" value={settings.screenshots_per_hour} onChange={e => save({ screenshots_per_hour: Number(e.target.value) })}>
            {[0, 1, 2, 3].map(n => <option key={n} value={n}>{n === 0 ? 'Off' : `${n} an hour`}</option>)}
          </select>
        </div>
      </div>

      <h2 className="reminders-subheading">Office networks</h2>
      <p className="admin-date sec-admin-note">
        Add the office’s network once. Anyone clocking in on it counts as in the office, even if the office’s internet address changes later (for laptops with the desktop app). Laptops registered on it are approved straight away; anywhere else, they wait for you.
      </p>
      <div className="reminders-list sec-network-mode">
        <div className="reminder-item">
          <div className="reminder-icon"><WifiIcon width={18} height={18} /></div>
          <div className="reminder-info">
            <h3>Clocking in off the office network</h3>
            <p>
              {settings.network_mode === 'office_only'
                ? 'Not allowed: people can only clock in on the office network (unless “Office network down today” is on).'
                : 'Allowed: it’s just recorded on the session. Good while people work from different places.'}
            </p>
          </div>
          <select className="admin-select" value={settings.network_mode || 'anywhere'} onChange={e => save({ network_mode: e.target.value })}>
            <option value="anywhere">Anywhere, just recorded</option>
            <option value="office_only">Office network only</option>
          </select>
        </div>
      </div>
      <div className="reminders-list">
        {networks.map(n => (
          <div className="reminder-item" key={n.id}>
            <div className="reminder-icon"><WifiIcon width={18} height={18} /></div>
            <div className="reminder-info">
              {renaming?.id === n.id ? (
                <div className="sec-inline-form">
                  <input type="text" value={renaming.value} maxLength={40} autoFocus
                    onChange={e => setRenaming({ id: n.id, value: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setRenaming(null); }} />
                  <button className="sec-btn-secondary" onClick={saveName} disabled={busy === n.id || !renaming.value.trim()}>Save</button>
                  <button className="sec-btn-link" onClick={() => setRenaming(null)}>Cancel</button>
                </div>
              ) : (
                <h3>{n.label}</h3>
              )}
              <p>{n.ip} · added {formatDayTime(n.created_at)}</p>
            </div>
            {renaming?.id !== n.id && (
              <div className="sec-row-actions">
                <button className="sec-btn-link" onClick={() => setRenaming({ id: n.id, value: n.label })} disabled={!!busy}>Rename</button>
                <button className="sec-btn-link" onClick={() => removeNetwork(n.id)} disabled={busy === n.id}>
                  {busy === n.id ? 'Removing…' : 'Remove'}
                </button>
              </div>
            )}
          </div>
        ))}
        <div className="reminder-item sec-action-item">
          <div className="reminder-icon"><WifiIcon width={18} height={18} /></div>
          <div className="reminder-info">
            <h3>Add a network</h3>
            <p>{networks.length ? 'Add a second line or another office.' : 'No networks yet, so the network check is off.'} The name is filled in from the Wi-Fi where possible; rename it any time.</p>
            <div className="sec-inline-form">
              <button className="btn-primary" onClick={() => addNetwork('mine')} disabled={!!busy}>
                {busy === 'mine' ? 'Adding…' : 'Add the network I’m on now'}
              </button>
            </div>
            <div className="sec-inline-form">
              <input type="text" placeholder="Or type the address, e.g. 41.66.212.10" value={ip} maxLength={45} onChange={e => setIp(e.target.value)} />
              <button className="sec-btn-secondary" onClick={() => addNetwork('typed')} disabled={!!busy || !ip.trim()}>
                {busy === 'typed' ? 'Adding…' : 'Add'}
              </button>
            </div>
            {recent.length > 0 && (
              <div className="sec-router-list sec-router-seen">
                <p className="sec-router-caption">Recently used, not office</p>
                {recent.map(x => (
                  <div className="sec-router-row" key={x.ip}>
                    <span>
                      <strong>{x.wifi || 'Unknown network'}</strong> · {x.ip}
                      <em> · {x.people.slice(0, 3).join(', ')}{x.people.length > 3 ? ` +${x.people.length - 3}` : ''} · {formatDayTime(x.last)}</em>
                    </span>
                    <button className="sec-btn-secondary" onClick={() => addNetwork('recent', x)} disabled={!!busy}>
                      {busy === x.ip ? 'Adding…' : 'Add as office'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className={`reminder-item ${outageToday ? 'sec-item-warn' : ''}`}>
          <div className="reminder-icon"><AlertIcon width={18} height={18} /></div>
          <div className="reminder-info">
            <h3>Office network down today</h3>
            <p>
              Internet or power out at the office and people are on mobile data? Switch this on and today’s clock-ins aren’t checked against the network. It switches itself off tomorrow.
            </p>
          </div>
          <label className="toggle-switch">
            <input type="checkbox" checked={outageToday} onChange={e => save({ network_outage_on: e.target.checked ? todayLocal() : null })} />
            <span className="toggle-slider"></span>
          </label>
        </div>
      </div>
      {error && <p className="admin-confirm-error">{error}</p>}
      {note && <p className="form-success sec-msg">{note}</p>}
    </>
  );
}

export default AdminSecuritySettings;
