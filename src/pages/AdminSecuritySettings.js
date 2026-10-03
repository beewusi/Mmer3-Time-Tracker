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
  const [wifi, setWifi] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    const [s, n] = await Promise.all([
      loadSecuritySettings(),
      supabase.from('office_networks').select('*').order('created_at')
    ]);
    setSettings(s);
    setNetworks(n.data || []);
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

  function addWifi() {
    const name = wifi.trim();
    if (!name) return;
    const list = settings.office_wifi_names || [];
    if (list.includes(name)) { setWifi(''); return; }
    save({ office_wifi_names: [...list, name] });
    setWifi('');
  }

  function removeWifi(name) {
    save({ office_wifi_names: (settings.office_wifi_names || []).filter(n => n !== name) });
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
      <p className="admin-date sec-admin-note">Nothing here stops anyone clocking in. A check that fails marks the session for the Review page.</p>
      <div className="reminders-list">
        <div className="reminder-item">
          <div className="reminder-icon"><LaptopIcon width={18} height={18} /></div>
          <div className="reminder-info">
            <h3>Registered laptop</h3>
            <p>Mark clock-ins from anyone without an approved work laptop. Turn off while people are still registering.</p>
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
            <p>Camera check with a blink at clock-in and during presence checks.</p>
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
        The office’s internet address. Clock-ins from anywhere else are marked “Not on the office network”. Add it from a computer in the office using “Add the network I’m on now”.
      </p>
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
            <h3>Office Wi-Fi names</h3>
            <p>Checked by the desktop app as a second signal. Type the name exactly as it shows on a laptop. Leave empty to skip this check.</p>
            {(settings.office_wifi_names || []).length > 0 && (
              <div className="review-chips sec-wifi-chips">
                {settings.office_wifi_names.map(n => (
                  <span className="review-chip" key={n}>
                    {n}
                    <button className="sec-chip-x" onClick={() => removeWifi(n)} aria-label={`Remove ${n}`}>×</button>
                  </span>
                ))}
              </div>
            )}
            <div className="sec-inline-form">
              <input
                type="text"
                placeholder="Wi-Fi name, e.g. Mmer3-Office"
                value={wifi}
                maxLength={64}
                onChange={e => setWifi(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addWifi(); }}
              />
              <button className="sec-btn-secondary" onClick={addWifi} disabled={!wifi.trim()}>Add</button>
            </div>
          </div>
        </div>
        <div className={`reminder-item ${outageToday ? 'sec-item-warn' : ''}`}>
          <div className="reminder-icon"><AlertIcon width={18} height={18} /></div>
          <div className="reminder-info">
            <h3>Office network down today</h3>
            <p>
              Internet or power out at the office and people are on mobile data? Switch this on and today’s clock-ins won’t be marked for the network. It switches itself off tomorrow.
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
