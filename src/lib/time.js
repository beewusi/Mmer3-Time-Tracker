// Clock times on records. Older ones were saved in the browser's own
// format ("08:02" or "08:02 AM"), new ones are saved as 24h "HH:MM".
// Everything on screen goes through formatClock() so it shows AM/PM.

// "08:02", "8:02 PM", "08:02:00", "8:02 p.m." -> minutes since midnight
export function parseClockTime(value) {
  if (!value) return null;
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])?\.?\s*m?\.?$/i);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const period = match[3] ? match[3].toLowerCase() : null;
  if (minutes > 59) return null;

  if (period) {
    if (hours < 1 || hours > 12) return null;
    if (period === 'a' && hours === 12) hours = 0;
    if (period === 'p' && hours !== 12) hours += 12;
  } else if (hours > 23) {
    return null;
  }
  return hours * 60 + minutes;
}

export function minutesToHHMM(totalMinutes) {
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Saved format for new records
export function dateToHHMM(date) {
  return minutesToHHMM(date.getHours() * 60 + date.getMinutes());
}

// "14:30" -> "2:30 PM". Anything unreadable is shown as it is.
export function formatClock(value) {
  const minutes = parseClockTime(value);
  if (minutes === null) return value || '';
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const period = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

function hmsToSeconds(value) {
  if (!value) return 0;
  const parts = String(value).split(':').map(Number);
  return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
}

export function secondsToHms(totalSeconds) {
  const safe = Math.max(Math.round(totalSeconds) || 0, 0);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Clock in -> clock out minus break, as "HH:MM:SS". null if a time can't be read.
// Clock out earlier than clock in = shift went past midnight.
export function calculateHoursWorked(clockIn, clockOut, breakTime) {
  const start = parseClockTime(clockIn);
  const end = parseClockTime(clockOut);
  if (start === null || end === null) return null;
  let minutes = end - start;
  if (minutes < 0) minutes += 24 * 60;
  return secondsToHms(minutes * 60 - hmsToSeconds(breakTime));
}

// records.date "DD/MM/YYYY" -> Date at midnight
export function parseRecordDate(dateStr) {
  if (!dateStr) return null;
  const [d, m, y] = String(dateStr).split('/').map(Number);
  if (!d || !m || !y) return null;
  return new Date(y, m - 1, d);
}

// A clock time ("HH:MM") on a given day, as a Date
export function clockTimeOnDate(baseDate, value) {
  const minutes = parseClockTime(value);
  if (minutes === null || !baseDate) return null;
  const date = new Date(baseDate);
  date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return date;
}

// Break list [{ start: "HH:MM", end: "HH:MM" | null }] -> total seconds
// (end past midnight wraps to the next day, open breaks count to `now`)
export function sumBreakSeconds(breakList, now = new Date()) {
  return breakList.reduce((total, b) => {
    const start = parseClockTime(b.start);
    if (start === null) return total;
    if (b.end === null) {
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      let open = nowMinutes - start;
      if (open < 0) open += 24 * 60;
      return total + open * 60;
    }
    const end = parseClockTime(b.end);
    if (end === null) return total;
    let minutes = end - start;
    if (minutes < 0) minutes += 24 * 60;
    return total + minutes * 60;
  }, 0);
}

// minutes after clock-in (wraps past midnight)
export function minutesAfter(clockIn, value) {
  const base = parseClockTime(clockIn);
  const time = parseClockTime(value);
  if (base === null || time === null) return null;
  return (time - base + 24 * 60) % (24 * 60);
}

// 13980 -> "3h 53m", 1200 -> "20m", 45 -> "0m"
export function formatDuration(totalSeconds) {
  const safe = Math.max(0, Math.round(totalSeconds) || 0);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

// Session checks: clock out after clock in, every break inside the session,
// end after start, no overlaps. sessionEnd = clock out, or now for a live one.
// Returns '' when fine, otherwise the message to show.
export function validateSession(clockIn, sessionEnd, breakList) {
  const length = minutesAfter(clockIn, sessionEnd);
  if (length === null) return 'Pick the clock in and clock out times.';
  if (length === 0) return 'Clock out has to be after clock in.';
  const spans = [];
  for (let i = 0; i < breakList.length; i += 1) {
    const b = breakList[i];
    const start = minutesAfter(clockIn, b.start);
    const end = b.end === null ? length : minutesAfter(clockIn, b.end);
    if (start === null || end === null) return 'Pick a start and end time for the break.';
    if (b.end !== null && end <= start) return 'A break has to end after it starts.';
    if (end > length || start > length) return 'Breaks have to be between clock in and clock out.';
    spans.push({ start, end });
  }
  spans.sort((x, y) => x.start - y.start);
  for (let i = 1; i < spans.length; i += 1) {
    if (spans[i].start < spans[i - 1].end) return 'Two breaks overlap.';
  }
  return '';
}

// "3 Oct, 09:41"
export function formatDayTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${dateToHHMM(d)}`;
}

// "just now", "12 min ago", "3 h ago", then the date
export function formatAgo(value) {
  if (!value) return '';
  const d = new Date(value);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return formatDayTime(d);
}
