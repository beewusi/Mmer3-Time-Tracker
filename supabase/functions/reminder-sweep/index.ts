// supabase/functions/reminder-sweep/index.ts
//
// Runs on a schedule (CRON_SETUP.sql). Checks employee_status and profiles for
// anyone past a reminder threshold who hasn't been notified yet, then sends an
// email and a desktop push. Works with every tab closed.
// - Push only reaches browsers where the employee turned on desktop
//   notifications (src/lib/push.js). Otherwise it's email only.
// - Also does the 8h15m auto clock-out: saves the record and sets them
//   clocked_out.
// - Clock-in checks: missed presence checks, desktop app contact gaps, and
//   deleting old screenshots/photos (14/30 days, as in the Privacy Notice).
//
// Needs REMINDER_SWEEP_SCHEMA.sql and PUSH_SUBSCRIPTIONS_SCHEMA.sql run first,
// plus the EMAILJS_PRIVATE_KEY and VAPID_* secrets.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

// ---------------- Config ----------------

// Org timezone as a UTC offset in minutes. One timezone for everyone for now,
// would need to be per-employee if I hire outside Ghana.
const ORG_UTC_OFFSET_MINUTES = 0; // Africa/Accra, UTC+0 all year

// Grace period before a clock-in counts as missed.
const MISSED_CLOCK_IN_GRACE_MINUTES = 15;

// Days with no missed-clock-in check (getUTCDay(): 0 = Sun, 6 = Sat). Org-wide
// for now, no per-employee schedules yet.
const NON_WORKING_DAYS = [0, 6];

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

// Same EmailJS service/template as Dashboard.js.
const EMAILJS_SERVICE_ID = 'service_qo5r5ol';
const EMAILJS_TEMPLATE_ID = 'template_iyjajm8';
const EMAILJS_PUBLIC_KEY = 'EWbasKvfwG1WXLCuA';
// Private key from a function secret, not in source:
//   supabase secrets set EMAILJS_PRIVATE_KEY=xxxxx
// (EmailJS dashboard > Account > API Keys). Needed because this call doesn't
// come from the registered site origin.
const EMAILJS_PRIVATE_KEY = Deno.env.get('EMAILJS_PRIVATE_KEY');

async function sendEmail(toEmail: string, toName: string, title: string, message: string) {
  if (!toEmail) return;
  if (!EMAILJS_PRIVATE_KEY) {
    console.log('[reminder-sweep] EMAILJS_PRIVATE_KEY not set — skipping email:', title, toEmail);
    return;
  }
  try {
    const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_ID,
        user_id: EMAILJS_PUBLIC_KEY,
        accessToken: EMAILJS_PRIVATE_KEY,
        template_params: {
          title,
          to_name: toName,
          to_email: toEmail,
          message
        }
      })
    });
    if (!res.ok) {
      console.log('[reminder-sweep] EmailJS error:', res.status, await res.text());
    }
  } catch (err) {
    console.log('[reminder-sweep] EmailJS request failed:', err);
  }
}

// VAPID keys from `npx web-push generate-vapid-keys`, stored as secrets
// (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT).
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY');
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY');
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT');

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// Push to every browser the employee enabled (push_subscriptions). No rows =
// never enabled, nothing to send.
async function sendPush(userId: string, title: string, body: string, tag: string) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
    console.log('[reminder-sweep] VAPID secrets not set — skipping push for', userId);
    return;
  }

  const { data: subs, error } = await supabase
    .from('push_subscriptions')
    .select('*')
    .eq('user_id', userId);

  if (error) {
    console.log('[reminder-sweep] Failed to load push_subscriptions for', userId, error);
    return;
  }
  if (!subs || subs.length === 0) return;

  const payload = JSON.stringify({ title, body, tag });

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
      await supabase
        .from('push_subscriptions')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', sub.id);
    } catch (err: any) {
      // 404/410 = dead subscription. Remove it so it doesn't fail every run.
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        console.log('[reminder-sweep] Removing expired push subscription', sub.id);
        await supabase.from('push_subscriptions').delete().eq('id', sub.id);
      } else {
        console.log('[reminder-sweep] Push send failed for', sub.id, err);
      }
    }
  }
}


function secondsToHms(totalSeconds: number) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// Same worked-seconds maths as applyServerClockState in Dashboard.js so both
// show the same time.
function workedSecondsFor(status: any, now: Date) {
  const clockInAt = status.clock_in_at ? new Date(status.clock_in_at).getTime() : now.getTime();
  const breakAccum = status.break_accum_seconds || 0;

  if (status.status === 'on_break' && status.break_started_at) {
    const breakStartAt = new Date(status.break_started_at).getTime();
    return Math.max(0, Math.round((breakStartAt - clockInAt) / 1000) - breakAccum);
  }
  return Math.max(0, Math.round((now.getTime() - clockInAt) / 1000) - breakAccum);
}

async function sweepBreakAndClockOutReminders(now: Date) {
  const { data: statuses, error } = await supabase
    .from('employee_status')
    .select('*')
    .in('status', ['clocked_in', 'on_break']);

  if (error) {
    console.log('[reminder-sweep] Failed to load employee_status:', error);
    return;
  }
  if (!statuses || statuses.length === 0) return;

  const userIds = statuses.map((s: any) => s.user_id);
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, email, full_name')
    .in('id', userIds);
  const profileById = new Map((profiles || []).map((p: any) => [p.id, p]));

  for (const status of statuses) {
    const profile = profileById.get(status.user_id);
    if (!profile) continue; // no profile, nothing to email

    const worked = workedSecondsFor(status, now);
    const updates: Record<string, any> = {};

    if (worked >= 7200 && !status.break_2h_sent) {
      updates.break_2h_sent = true;
      await sendEmail(profile.email, profile.full_name, 'Break Nudge',
        'You have been working for 2 hours. A short break can help.');
      await sendPush(status.user_id, 'Mmer3 — Break Reminder',
        'You\u2019ve been working for 2 hours. Consider taking a short break.', 'break-2h');
    }
    if (worked >= 10800 && !status.break_3h_sent) {
      updates.break_3h_sent = true;
      await sendEmail(profile.email, profile.full_name, 'Break Reminder',
        'You have been working for 3 hours. Time to take a break.');
      await sendPush(status.user_id, 'Mmer3 — Break Reminder',
        'You\u2019ve been working for 3 hours. It\u2019s time to take a break.', 'break-3h');
    }
    if (worked >= 28800 && !status.clock_out_8h_sent) {
      updates.clock_out_8h_sent = true;
      await sendEmail(profile.email, profile.full_name, 'Clock Out Reminder',
        'You have worked 8 hours. Please clock out.');
      await sendPush(status.user_id, 'Mmer3 — Clock-Out Reminder',
        'You\u2019ve worked 8 hours. Please clock out when you\u2019re finished.', 'clock-out-8h');
    }
    if (worked >= 29700 && !status.auto_clock_out_sent) {
      updates.auto_clock_out_sent = true;
      await sendEmail(profile.email, profile.full_name, 'Auto Clock Out',
        'You are being automatically clocked out after 8 hours 15 minutes.');
      await sendPush(status.user_id, 'Mmer3 — Automatic Clock-Out',
        'You\u2019ve reached 8 hours 15 minutes, so Mmer3 has automatically clocked you out.', 'auto-clock-out');

      // Auto clock-out, same steps as handleAdminClockOut: save the record,
      // reset employee_status. Location comes from employee_status (was
      // hardcoded to 'unavailable', which showed N/A).
      const clockInAt = status.clock_in_at ? new Date(status.clock_in_at) : now;
      const totalSeconds = Math.max(0, Math.round((now.getTime() - clockInAt.getTime()) / 1000) - (status.break_accum_seconds || 0));

      await supabase.from('records').insert([{
        user_id: status.user_id,
        date: now.toLocaleDateString('en-GB'),
        clock_in: clockInAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        clock_out: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        hours_worked: secondsToHms(totalSeconds),
        break_time: secondsToHms(status.break_accum_seconds || 0),
        location_status: status.location_status || 'unavailable',
        adjusted_by_admin: false
      }]);

      updates.status = 'clocked_out';
      updates.clock_in_at = null;
      updates.break_started_at = null;
      updates.break_accum_seconds = 0;
      // Only if the column exists, so the update can't fail and leave them
      // clocked in before location_status.sql is run.
      if ('location_status' in status) updates.location_status = null;
    }

    if (Object.keys(updates).length > 0) {
      updates.updated_at = now.toISOString();
      await supabase.from('employee_status').update(updates).eq('user_id', status.user_id);
    }
  }
}

async function sweepMissedClockIn(now: Date) {
  // "today"/"now" in the org timezone, not the server's UTC. Shift by the
  // offset then read with the UTC getters. No-op for Accra but ready if the
  // offset changes.
  const localNow = new Date(now.getTime() + ORG_UTC_OFFSET_MINUTES * 60000);
  const dayOfWeek = localNow.getUTCDay();
  if (NON_WORKING_DAYS.includes(dayOfWeek)) return;

  const todayIso = localNow.toISOString().slice(0, 10);

  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('id, email, full_name, expected_clock_in_time, missed_clock_in_notified_date, optional_reminders, is_admin, status')
    .eq('is_admin', false)
    .eq('status', 'approved');

  if (error) {
    console.log('[reminder-sweep] Failed to load profiles for missed clock-in:', error);
    return;
  }
  if (!profiles || profiles.length === 0) return;

  // Only people who turned this reminder on and haven't been notified today.
  const candidates = profiles.filter((p: any) =>
    p.optional_reminders && p.optional_reminders.missedClockIn &&
    p.missed_clock_in_notified_date !== todayIso
  );
  if (candidates.length === 0) return;
  const candidateIds = candidates.map((p: any) => p.id);

  const { data: statuses } = await supabase
    .from('employee_status')
    .select('*')
    .in('user_id', candidateIds);
  const statusById = new Map((statuses || []).map((s: any) => [s.user_id, s]));

  const { data: timeOff } = await supabase
    .from('time_off_requests')
    .select('user_id, status, start_date, end_date')
    .in('user_id', candidateIds)
    .eq('status', 'approved')
    .lte('start_date', todayIso)
    .gte('end_date', todayIso);
  const onLeaveIds = new Set((timeOff || []).map((t: any) => t.user_id));

  for (const profile of candidates) {
    if (onLeaveIds.has(profile.id)) continue;

    const status = statusById.get(profile.id);
    // Already clocked in/out today, not missed. Checking the date because a
    // stale 'clocked_out' from another day doesn't count (same as getStatus in
    // AdminDashboard.js).
    if (status) {
      const relevantAt = status.clock_in_at || status.updated_at;
      const relevantDateIso = relevantAt
        ? new Date(new Date(relevantAt).getTime() + ORG_UTC_OFFSET_MINUTES * 60000).toISOString().slice(0, 10)
        : null;
      if (relevantDateIso === todayIso && status.status !== 'not_clocked_in') continue;
    }

    const expected = profile.expected_clock_in_time || '08:00:00';
    const [expH, expM] = expected.split(':').map((n: string) => parseInt(n, 10));
    const deadline = new Date(localNow);
    deadline.setUTCHours(expH, expM + MISSED_CLOCK_IN_GRACE_MINUTES, 0, 0);

    if (localNow.getTime() < deadline.getTime()) continue; // grace period not up yet

    await sendEmail(profile.email, profile.full_name, 'Missed Clock-In — Mmerℇ',
      `It's past ${expected.slice(0, 5)} and I don't see you clocked in yet today. If this is expected (leave, a late start, etc.) you can ignore this.`);
    await sendPush(profile.id, 'Mmer3 — Missed Clock-In',
      'You haven\u2019t clocked in yet today. If you\u2019re starting late or on leave, you can ignore this reminder.', 'missed-clock-in');

    await supabase
      .from('profiles')
      .update({ missed_clock_in_notified_date: todayIso })
      .eq('id', profile.id);
  }
}

// ---------------- Clock-in checks (supabase/clock_in_checks.sql) ----------------
// Each part is skipped quietly if the tables aren't there yet.

const CONTACT_GAP_MINUTES = 20;     // desktop app silent this long while clocked in = gap
const CONTACT_GAP_FLAG_MINUTES = 30;
const DESKTOP_RECENT_DAYS = 7;      // only for people who actually run the desktop app
const SCREENSHOT_KEEP_DAYS = 14;    // as promised in the Privacy Notice
const PHOTO_KEEP_DAYS = 30;
const SIGN_IN_KEEP_DAYS = 30;

const minutesBetween = (a: string | Date, b: string | Date) =>
  (new Date(b).getTime() - new Date(a).getTime()) / 60000;

// Presence checks past their window: missed, unless the person was on a break
// (moved to later) or the session had already ended (dropped).
async function sweepPresenceChecks(now: Date) {
  const { data: overdue, error } = await supabase
    .from('presence_checks').select('*')
    .eq('result', 'pending').lt('expires_at', now.toISOString()).limit(500);
  if (error || !overdue?.length) return;

  const userIds = [...new Set(overdue.map((c: any) => c.user_id))];
  const { data: statuses } = await supabase.from('employee_status').select('*').in('user_id', userIds);
  const statusOf = new Map((statuses || []).map((s: any) => [String(s.user_id), s]));

  for (const check of overdue) {
    const status: any = statusOf.get(String(check.user_id));
    const live = status && ['clocked_in', 'on_break'].includes(status.status) && status.session_id === check.session_id;

    if (!live) {
      // session over: was the check before or after it ended?
      const { data: rec } = await supabase
        .from('records').select('created_at').eq('session_id', check.session_id).maybeSingle();
      if (!rec || new Date(check.due_at) >= new Date(rec.created_at)) {
        await supabase.from('presence_checks').delete().eq('id', check.id);
        continue;
      }
    }

    // on a break during the window? ask again a bit later instead
    const { data: breaks } = await supabase
      .from('breaks').select('started_at, ended_at')
      .eq('user_id', check.user_id).lte('started_at', check.expires_at);
    const onBreak = (breaks || []).some((b: any) => !b.ended_at || new Date(b.ended_at) >= new Date(check.due_at));
    if (onBreak && live) {
      const due = new Date(now.getTime() + (10 + Math.random() * 20) * 60000);
      const windowMin = minutesBetween(check.due_at, check.expires_at) || 5;
      await supabase.from('presence_checks').update({
        due_at: due.toISOString(),
        expires_at: new Date(due.getTime() + windowMin * 60000).toISOString()
      }).eq('id', check.id);
      continue;
    }

    await supabase.from('presence_checks').update({ result: 'missed' }).eq('id', check.id);
    await supabase.from('session_flags').insert({
      user_id: check.user_id,
      session_id: check.session_id,
      type: 'presence_missed',
      severity: 'medium',
      details: { check_id: check.id, due_at: check.due_at }
    });
  }
}

// Desktop app gone quiet while someone is clocked in (closed, laptop off or
// taken away). Logged as a contact gap; long ones are flagged.
async function sweepContactGaps(now: Date) {
  const { data: beats, error } = await supabase.from('heartbeats').select('*');
  if (error || !beats?.length) return;
  const { data: statuses } = await supabase.from('employee_status').select('*');
  const statusOf = new Map((statuses || []).map((s: any) => [String(s.user_id), s]));

  for (const hb of beats) {
    if (!hb.desktop_seen_at || minutesBetween(hb.desktop_seen_at, now) > DESKTOP_RECENT_DAYS * 1440) continue;
    const status: any = statusOf.get(String(hb.user_id));
    const working = status?.status === 'clocked_in';
    const silentFor = minutesBetween(hb.desktop_seen_at, now);

    if (!hb.open_gap_started_at) {
      // quiet since whichever came later: the last contact or the clock-in
      // (covers the app not being started at all today)
      const quietSince = new Date(Math.max(new Date(hb.desktop_seen_at).getTime(), new Date(status?.clock_in_at || 0).getTime()));
      if (working && minutesBetween(quietSince, now) >= CONTACT_GAP_MINUTES) {
        await supabase.from('heartbeats').update({ open_gap_started_at: quietSince.toISOString() }).eq('user_id', hb.user_id);
      }
      continue;
    }

    // gap open: closed when the app is back, or the session/break ends it
    const backAt = new Date(hb.desktop_seen_at) > new Date(hb.open_gap_started_at) ? hb.desktop_seen_at : null;
    if (!backAt && working) continue;
    const endedAt = backAt || now.toISOString();
    const minutes = Math.round(minutesBetween(hb.open_gap_started_at, endedAt));

    await supabase.from('activity_events').insert({
      user_id: hb.user_id,
      session_id: status?.session_id || null,
      type: 'contact_gap',
      started_at: hb.open_gap_started_at,
      ended_at: endedAt,
      source: 'server'
    });
    if (minutes >= CONTACT_GAP_FLAG_MINUTES && status?.session_id) {
      await supabase.from('session_flags').insert({
        user_id: hb.user_id,
        session_id: status.session_id,
        type: 'contact_gap',
        severity: minutes >= 90 ? 'medium' : 'low',
        details: { minutes, from: hb.open_gap_started_at, to: endedAt }
      });
    }
    await supabase.from('heartbeats').update({ open_gap_started_at: null }).eq('user_id', hb.user_id);
  }
}

// Delete screenshots and check photos once they're past what the Privacy
// Notice says. A batch per run, so a backlog clears over a few runs.
async function sweepRetention(now: Date) {
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86400000).toISOString();

  const { data: shots } = await supabase
    .from('screenshots').select('id, path').lt('taken_at', daysAgo(SCREENSHOT_KEEP_DAYS)).limit(200);
  if (shots?.length) {
    await supabase.storage.from('screenshots').remove(shots.map((s: any) => s.path));
    await supabase.from('screenshots').delete().in('id', shots.map((s: any) => s.id));
  }

  for (const table of ['clock_evidence', 'presence_checks']) {
    const dateCol = table === 'clock_evidence' ? 'created_at' : 'due_at';
    const { data: rows } = await supabase
      .from(table).select('id, photo_path')
      .not('photo_path', 'is', null).lt(dateCol, daysAgo(PHOTO_KEEP_DAYS)).limit(200);
    if (rows?.length) {
      await supabase.storage.from('evidence').remove(rows.map((r: any) => r.photo_path));
      await supabase.from(table).update({ photo_path: null }).in('id', rows.map((r: any) => r.id));
    }
  }

  await supabase.from('sign_in_attempts').delete().lt('created_at', daysAgo(SIGN_IN_KEEP_DAYS));
}

// A session with no clock-in checks at all: clocked in some other way than
// the Clock In button (or the checks never arrived). Flagged once, high.
const NO_CHECKS_AFTER_MINUTES = 5;

async function sweepSessionsWithoutChecks(now: Date) {
  const { data: live, error } = await supabase
    .from('employee_status').select('user_id, session_id, clock_in_at, status')
    .in('status', ['clocked_in', 'on_break']);
  if (error || !live?.length) return;

  for (const s of live) {
    if (!s.session_id || !s.clock_in_at) continue;
    if (minutesBetween(s.clock_in_at, now) < NO_CHECKS_AFTER_MINUTES) continue;
    const [{ data: ev }, { data: fl }] = await Promise.all([
      supabase.from('clock_evidence').select('id').eq('session_id', s.session_id).limit(1),
      supabase.from('session_flags').select('id').eq('session_id', s.session_id).eq('type', 'no_checks').limit(1)
    ]);
    if (ev?.length || fl?.length) continue;
    await supabase.from('session_flags').insert({
      user_id: s.user_id,
      session_id: s.session_id,
      type: 'no_checks',
      severity: 'high',
      details: { clock_in_at: s.clock_in_at }
    });
  }
}

async function safely(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    console.log(`[reminder-sweep] ${name} failed:`, err);
  }
}

Deno.serve(async (_req) => {
  const now = new Date();
  await sweepBreakAndClockOutReminders(now);
  await sweepMissedClockIn(now);
  await safely('sessions without checks', () => sweepSessionsWithoutChecks(now));
  await safely('presence checks', () => sweepPresenceChecks(now));
  await safely('contact gaps', () => sweepContactGaps(now));
  await safely('retention', () => sweepRetention(now));
  return new Response(JSON.stringify({ ok: true, ranAt: now.toISOString() }), {
    headers: { 'Content-Type': 'application/json' }
  });
});
