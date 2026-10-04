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
  const [label, setLabel] = useState('');
  const [ip, setIp] = useState('');
  const [routers, setRouters] = useState([]);
  const [seen, setSeen] = useState([]);           // routers the desktop app has seen lately
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const [s, n, r, h, p] = await Promise.all([
      loadSecuritySettings(),
      supabase.from('office_networks').select('*').order('created_at'),
      supabase.from('office_routers').select('*').order('created_at'),
      supabase.from('heartbeats').select('user_id, wifi_name, wifi_router, desktop_seen_at').not('wifi_router', 'is', null).gte('desktop_seen_at', since),
      supabase.from('profiles').select('id, full_name, email')
    ]);
    setSettings(s);
    setNetworks(n.data || []);
    setRouters(r.data || []);
    // one line per router: its Wi-Fi name, who's on it, when last seen
    const names = new Map((p.data || []).map(x => [x.id, x.full_name || x.email]));
    const byRouter = new Map();
    (h.data || []).forEach(b => {
      const key = b.wifi_router;
      const entry = byRouter.get(key) || { router: key, wifi: b.wifi_name, people: [], last: b.desktop_seen_at };
      entry.people.push(names.get(b.user_id) || 'Someone');
      if (b.desktop_seen_at > entry.last) entry.last = b.desktop_seen_at;
      if (!entry.wifi && b.wifi_name) entry.wifi = b.wifi_name;
      byRouter.set(key, entry);
    });
    setSeen([...byRouter.values()].sort((a, b) => (a.last < b.last ? 1 : -1)));
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

  async function addNetwork(useMine) {
    setError('');
    setNote('');
    setBusy(useMine ? 'mine' : 'add');
    try {
      let address = ip.trim();
      if (useMine) {
        const res = await callClockCheck('my-ip');
        address = res?.ip || '';
        if (!address) throw new Error('Couldn’t read this connection’s address.');
      }
      if (!/^[0-9a-fA-F:.]{3,45}$/.test(address)) throw new Error('That doesn’t look like an internet address.');
      if (networks.some(n => n.ip === address)) throw new Error(`${address} is already on the list.`);
      const { error: err } = await supabase.from('office_networks').insert({ label: label.trim() || 'Office', ip: address });
      if (err) throw err;
      setNote(`Added ${address}.`);
      setLabel('');
      setIp('');
      load();
    } catch (err) {
      setError(err.message);
    }
    setBusy('');
  }

  async function addRouter(entry) {
    setError('');
    setNote('');
    setBusy(entry.router);
    const { error: err } = await supabase.from('office_routers')
      .insert({ label: entry.wifi || 'Office Wi-Fi', router: entry.router });
    setBusy('');
    if (err) setError(err.message);
    else setNote(`${entry.wifi || 'That router'} now counts as the office.`);
    load();
  }

  async function removeRouter(id) {
    setBusy(id);
    await supabase.from('office_routers').delete().eq('id', id);
    setBusy('');
    load();
  }

  const sameRouter = (a, b) => a.slice(0, 14) === b.slice(0, 14);

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
      <p className="admin-date sec-admin-note">Nothing here stops anyone clocking in. A check that fails marks the session for the Review page.</p>
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
        How Mmerℇ knows someone is in the office: the office’s Wi-Fi router (best, needs the desktop app) or its internet address (may change on home and some business lines). Laptops registered in the office are approved straight away; anywhere else, they wait for you.
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
              <h3>{n.label}</h3>
              <p>{n.ip} · added {formatDayTime(n.created_at)}</p>
            </div>
            <button className="sec-btn-link" onClick={() => removeNetwork(n.id)} disabled={busy === n.id}>
              {busy === n.id ? 'Removing…' : 'Remove'}
            </button>
          </div>
        ))}
        <div className="reminder-item sec-action-item">
          <div className="reminder-icon"><WifiIcon width={18} height={18} /></div>
          <div className="reminder-info">
            <h3>Add a network</h3>
            <p>{networks.length ? 'Add a second line or another office.' : 'No networks yet, so the network check is off.'}</p>
            <div className="sec-inline-form">
              <input type="text" placeholder="Name, e.g. Head office" value={label} maxLength={40} onChange={e => setLabel(e.target.value)} />
              <button className="btn-primary" onClick={() => addNetwork(true)} disabled={!!busy}>
                {busy === 'mine' ? 'Adding…' : 'Add the network I’m on now'}
              </button>
            </div>
            <div className="sec-inline-form">
              <input type="text" placeholder="Or type the address, e.g. 41.66.212.10" value={ip} maxLength={45} onChange={e => setIp(e.target.value)} />
              <button className="sec-btn-secondary" onClick={() => addNetwork(false)} disabled={!!busy || !ip.trim()}>
                {busy === 'add' ? 'Adding…' : 'Add'}
              </button>
            </div>
          </div>
        </div>
        <div className="reminder-item sec-action-item">
          <div className="reminder-icon"><WifiIcon width={18} height={18} /></div>
          <div className="reminder-info">
            <h3>Office Wi-Fi routers</h3>
            <p>
              Each router has its own ID that doesn’t change when the internet address does. A laptop running the Mmerℇ desktop app on one of these counts as in the office. Routers the desktop app has seen in the last week are listed below: add the office ones.
            </p>
            {routers.length > 0 && (
              <div className="sec-router-list">
                {routers.map(r => (
                  <div className="sec-router-row" key={r.id}>
                    <span><strong>{r.label}</strong> · {r.router}</span>
                    <button className="sec-btn-link" onClick={() => removeRouter(r.id)} disabled={busy === r.id}>
                      {busy === r.id ? 'Removing…' : 'Remove'}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {seen.filter(x => !routers.some(r => sameRouter(r.router, x.router))).length > 0 ? (
              <div className="sec-router-list sec-router-seen">
                <p className="sec-router-caption">Seen by the desktop app</p>
                {seen.filter(x => !routers.some(r => sameRouter(r.router, x.router))).map(x => (
                  <div className="sec-router-row" key={x.router}>
                    <span>
                      <strong>{x.wifi || 'Wi-Fi'}</strong> · {x.router}
                      <em> · {x.people.slice(0, 3).join(', ')}{x.people.length > 3 ? ` +${x.people.length - 3}` : ''} · {formatDayTime(x.last)}</em>
                    </span>
                    <button className="sec-btn-secondary" onClick={() => addRouter(x)} disabled={!!busy}>
                      {busy === x.router ? 'Adding…' : 'This is the office'}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="sec-router-caption">No other routers seen yet. Open the desktop app on a laptop in the office and it shows up here within a minute.</p>
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
