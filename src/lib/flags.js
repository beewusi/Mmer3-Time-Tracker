// Names for the flag types in session_flags, shared by My Activity and the
// admin Review page.
export const FLAG_LABELS = {
  device_unregistered: 'No approved laptop',
  device_not_verified: 'Laptop not verified',
  face_failed: 'Face check failed',
  face_not_registered: 'No face check set up',
  off_network: 'Not on the office network',
  same_device: 'Same laptop as another account',
  presence_missed: 'Presence check missed',
  presence_failed: 'Presence check failed',
  away: 'Away from the computer',
  contact_gap: 'App out of contact',
  unauthorised_location: 'Outside the office area',
  offline_clock_in: 'Clocked in offline',
  no_checks: 'Clock-in checks not received'
};

export const FLAG_STATUS = {
  open: { label: 'Waiting for review', tone: 'pending' },
  authorised: { label: 'Accepted', tone: 'active' },
  declined: { label: 'Declined', tone: 'danger' }
};

const clock = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function flagSummary(flag) {
  const d = flag.details || {};
  switch (flag.type) {
    case 'device_not_verified': return d.reason || '';
    case 'face_failed': return d.reason ? `${d.reason}${d.attempts ? ` after ${d.attempts} ${d.attempts === 1 ? 'try' : 'tries'}` : ''}` : '';
    case 'off_network': return [d.ip && `internet address ${d.ip}`, d.wifi && `Wi-Fi “${d.wifi}”`].filter(Boolean).join(', ').replace(/^./, c => c.toUpperCase());
    case 'away': return d.minutes ? `${d.minutes} min ${d.kind === 'locked' ? 'with the screen locked' : 'with no activity'}` : '';
    case 'contact_gap': return d.minutes ? `No contact for ${d.minutes} min` : '';
    case 'presence_missed': return d.due_at ? `Asked at ${clock(d.due_at)}` : '';
    case 'presence_failed': return [d.reason, d.due_at && `asked at ${clock(d.due_at)}`].filter(Boolean).join(', ');
    case 'face_not_registered': return d.status === 'pending' ? 'Face waiting for approval' : d.status === 'withdrawn' ? 'Consent withdrawn' : '';
    case 'offline_clock_in': return d.claimed_at ? `Clocked in at ${new Date(d.claimed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} with no connection, sent ${d.minutes_late || 0} min later` : '';
    case 'no_checks': return 'Clocked in without the laptop, face and network checks reaching Mmerℇ';
    default: return '';
  }
}
