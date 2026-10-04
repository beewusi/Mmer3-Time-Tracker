// supabase/functions/clock-check/index.ts
//
// The checks behind a clock-in. Everything that decides whether a session gets
// flagged runs here, not in the browser:
//   register-options / register-verify   register a work laptop (passkey)
//   auth-options                         passkey challenge before clocking in
//   clock-in                             face + laptop (+ network if office only)
//                                        checked, then the session is started here,
//                                        evidence saved, presence checks scheduled.
//                                        Also takes a clock-in made while offline.
//   resume                               back from a pause after a missed presence
//                                        check (face again)
//   clock-out                            hours worked out here, session saved
//   face-try                             does this face match? (between tries, nothing saved)
//   presence                             answer a presence check (face matched here)
//   my-ip                                the internet address the request came from
//                                        (admin "add the network I'm on now")
//
// Missing setup, no face, or not their laptop blocks the clock-in. A face that
// doesn't match after 3 tries clocks in and goes to Review; everything else
// is just recorded on the session.
//
// Deploy: supabase functions deploy clock-check
// Optional secret: APP_ORIGINS = comma-separated site addresses allowed to use
// passkeys, e.g. https://mmer3.onrender.com,http://localhost:3000
// (without it: localhost and any https://*.onrender.com address)
// Needs supabase/clock_in_checks.sql.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} from 'npm:@simplewebauthn/server@14';
import { isoBase64URL } from 'npm:@simplewebauthn/server@14/helpers';

const RP_NAME = 'Mmerℇ';
const FACE_MATCH = 0.5;              // face-api distance, lower = closer
const FACE_TRIES = 3;                // then a mismatch clocks in and goes to Review
const CHALLENGE_MINUTES = 5;
const SAME_DEVICE_HOURS = 12;
const WORKDAY_MINUTES = 8 * 60;      // auto clock-out is at 8 h 15 min
const FIRST_CHECK_AFTER = 30;        // minutes, no presence check straight after clocking in

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' }
  });
}

// ---------- helpers ----------

function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  const list = (Deno.env.get('APP_ORIGINS') ?? '')
    .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
  if (list.length) return list.includes(origin) ? origin : null;
  if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return origin;
  if (/^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(origin)) return origin;
  return null;
}

// Address set by Supabase's own front door first (the caller can't choose
// it); x-forwarded-for's first entry can be typed in by the caller, so it's
// only the last resort.
function callerIp(req: Request): string | null {
  const direct = trustedIp(req);
  if (direct) return direct;
  const fwd = req.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : null;
}

// only the address the platform itself sets: used for anything that decides
// (laptop approved, office only). Unknown = treated as not the office.
function trustedIp(req: Request): string | null {
  const direct = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip');
  return direct ? direct.trim() : null;
}

// Photo has to be this person's, of the right kind, and taken just now
// (the name carries the time), so an old photo can't be passed off.
function freshPhoto(path: unknown, userId: string, kind: 'clockin' | 'presence', since: number): string | null {
  if (typeof path !== 'string') return null;
  const m = path.match(new RegExp(`^${userId}/${kind}-(\\d{13})\\.jpg$`));
  if (!m) return null;
  const takenAt = Number(m[1]);
  return takenAt >= since - 2 * 60000 && takenAt <= Date.now() + 2 * 60000 ? path : null;
}

function distance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

function validDescriptor(d: unknown): d is number[] {
  return Array.isArray(d) && d.length === 128 && d.every(n => typeof n === 'number' && Number.isFinite(n));
}

// refused, with a code the app can act on (e.g. open Devices & Security)
function blocked(code: string, message: string) {
  return json({ error: message, code, blocked: true }, 403);
}

// records keep the date as DD/MM/YYYY and times as HH:MM, Ghana time (GMT)
function ghanaDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

function ghanaClock(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function hms(total: number): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(total / 3600))}:${p(Math.floor((total % 3600) / 60))}:${p(total % 60)}`;
}

// today in Ghana (GMT, no daylight saving)
function todayGhana(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------- main ----------

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) return json({ error: 'Not signed in' }, 401);

    const db = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const body = await req.json().catch(() => ({}));
    const action = body.action as string;

    if (action === 'my-ip') {
      return json({ ip: callerIp(req) });
    }

    // passkeys are tied to the site address, so the origin has to be one of ours
    const needsOrigin = ['register-options', 'register-verify', 'auth-options', 'clock-in'];
    const origin = allowedOrigin(req.headers.get('origin'));
    if (needsOrigin.includes(action) && !origin) {
      return json({ error: 'This site address is not allowed to use passkeys' }, 400);
    }
    const rpID = origin ? new URL(origin).hostname : '';

    // ---------- register a laptop ----------
    if (action === 'register-options') {
      const { data: existing } = await db
        .from('devices').select('credential_id, transports')
        .eq('user_id', user.id).neq('status', 'revoked');

      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID,
        userName: user.email ?? user.id,
        userID: new TextEncoder().encode(user.id),
        attestationType: 'none',
        excludeCredentials: (existing ?? []).map(d => ({ id: d.credential_id, transports: d.transports ?? undefined })),
        authenticatorSelection: {
          authenticatorAttachment: 'platform',   // the laptop itself, not a phone or USB key
          residentKey: 'preferred',
          userVerification: 'required'          // Windows Hello / Touch ID every time
        },
        preferredAuthenticatorType: 'localDevice'
      });

      await db.from('webauthn_challenges').delete().eq('user_id', user.id).eq('purpose', 'register');
      await db.from('webauthn_challenges').insert({ user_id: user.id, challenge: options.challenge, purpose: 'register' });
      return json({ options });
    }

    if (action === 'register-verify') {
      const challenge = await takeChallenge(db, user.id, 'register');
      if (!challenge) return json({ error: 'That took too long. Please try again.' }, 400);

      const result = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: challenge,
        expectedOrigin: origin!,
        expectedRPID: rpID,
        requireUserVerification: true
      });
      if (!result.verified) return json({ error: 'The laptop could not be registered' }, 400);

      const { credential, credentialBackedUp } = result.registrationInfo;
      const label = String(body.label ?? '').trim().slice(0, 60) || 'Work laptop';
      const deviceKey = typeof body.deviceKey === 'string' ? body.deviceKey.slice(0, 64) : null;

      // already someone else's laptop (same browser)
      if (deviceKey) {
        const { data: theirs } = await db
          .from('devices').select('id').eq('device_key', deviceKey).neq('user_id', user.id).neq('status', 'revoked').limit(1);
        if (theirs?.length) {
          return blocked('LAPTOP_TAKEN', 'This laptop is already registered to someone else. Register your own work laptop.');
        }
      }

      // on an office network: approved straight away. Anywhere else: waits
      // for the admin (their hours are held until then).
      const ip = trustedIp(req);
      const { data: networks } = await db.from('office_networks').select('ip');
      const onOffice = !!ip && (networks ?? []).some(n => n.ip === ip);

      const { data: device, error } = await db.from('devices').insert({
        user_id: user.id,
        label,
        credential_id: credential.id,
        public_key: isoBase64URL.fromBuffer(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports ?? null,
        device_key: deviceKey,
        synced: credentialBackedUp,
        registered_ip: ip ?? callerIp(req),
        status: onOffice ? 'approved' : 'pending',
        approved_at: onOffice ? new Date().toISOString() : null,
        approved_how: onOffice ? 'office_network' : null
      }).select('id, label, status, created_at, synced').single();
      if (error) throw error;
      return json({ device });
    }

    // ---------- passkey challenge before clocking in ----------
    if (action === 'auth-options') {
      // approved, or still waiting for the admin (they can work meanwhile)
      const { data: devices } = await db
        .from('devices').select('credential_id, transports')
        .eq('user_id', user.id).in('status', ['approved', 'pending']);
      if (!devices?.length) return json({ options: null });

      const options = await generateAuthenticationOptions({
        rpID,
        allowCredentials: devices.map(d => ({ id: d.credential_id, transports: d.transports ?? undefined })),
        userVerification: 'required'
      });
      await db.from('webauthn_challenges').delete().eq('user_id', user.id).eq('purpose', 'verify');
      await db.from('webauthn_challenges').insert({ user_id: user.id, challenge: options.challenge, purpose: 'verify' });
      return json({ options });
    }

    // ---------- clock in ----------
    // Checked here first, then the session is started here (the browser can't
    // start one itself). Blocked: no face set up, no face seen, not their
    // laptop, no laptop registered, off the office network when Settings says
    // office only. Face not matching after 3 tries: clocked in, goes to Review.
    // clockInAt = a clock-in made while offline, sent now it's back.
    if (action === 'clock-in') {
      const { data: current } = await db
        .from('employee_status').select('status').eq('user_id', user.id).maybeSingle();
      if (current && ['clocked_in', 'on_break'].includes(current.status)) {
        return json({ ok: true, alreadyLive: true });
      }

      const { data: settings } = await db.from('security_settings').select('*').eq('id', 1).maybeSingle();
      const flags: { type: string; severity: string; details: Record<string, unknown> }[] = [];
      const flag = (type: string, severity: string, details: Record<string, unknown> = {}) =>
        flags.push({ type, severity, details });

      // offline clock-in: the time it was made, up to 6 hours back
      let clockInAt = new Date();
      if (body.clockInAt) {
        const claimed = new Date(String(body.clockInAt));
        if (Number.isNaN(claimed.getTime()) || claimed.getTime() > Date.now() + 60000 || claimed.getTime() < Date.now() - 6 * 3600000) {
          return blocked('OFFLINE_TOO_OLD', 'That offline clock-in is too old to send. Clock in again, or ask your admin to add the time.');
        }
        clockInAt = claimed;
        flag('offline_clock_in', 'medium', {
          claimed_at: claimed.toISOString(),
          sent_at: new Date().toISOString(),
          minutes_late: Math.round((Date.now() - claimed.getTime()) / 60000)
        });
      }

      // face: required
      const face = body.face ?? {};
      let faceResult = 'skipped';
      let faceDistance: number | null = null;
      if (settings?.face_check_enabled !== false) {
        const { data: profile } = await db
          .from('face_profiles').select('descriptor, status').eq('user_id', user.id).maybeSingle();
        if (!profile || profile.status !== 'approved') {
          return blocked('FACE_SETUP', 'Set up your face check in Devices & Security before you clock in.');
        }
        if (face.noFace || !validDescriptor(face.descriptor)) {
          return blocked('NO_FACE', 'No face was seen, so you can’t clock in. Turn the camera on, face it in good light and try again.');
        }
        faceDistance = distance(face.descriptor, profile.descriptor);
        const matched = faceDistance < FACE_MATCH;
        const tries = Number.isInteger(face.attempts) ? face.attempts : 1;
        if ((!matched || face.blink !== true) && tries < FACE_TRIES) {
          return blocked('FACE_RETRY', 'That didn’t pass. Please try the face check again.');
        }
        faceResult = matched ? 'match' : 'no_match';
        if (!matched) {
          flag('face_failed', 'high', { reason: 'Face did not match', distance: round(faceDistance), attempts: tries });
        } else if (face.blink !== true) {
          flag('face_failed', 'medium', { reason: 'Face matched but the eyes weren’t seen closing (could be a photo)', distance: round(faceDistance), attempts: tries });
        }
      }

      // laptop: registered (approved, or waiting for the admin) and this is it
      let deviceVerified = false;
      let deviceId: string | null = null;
      let laptopPending = false;
      const deviceKey = typeof body.deviceKey === 'string' ? body.deviceKey.slice(0, 64) : null;
      if (settings?.require_registered_device !== false) {
        const { data: mine } = await db
          .from('devices').select('*').eq('user_id', user.id).in('status', ['approved', 'pending']);
        if (!mine?.length) {
          return blocked('LAPTOP_SETUP', 'Register this laptop in Devices & Security before you clock in.');
        }
        if (!body.assertion) {
          return blocked('LAPTOP_CHECK', body.passkeyError || 'The laptop check wasn’t done. Please try again.');
        }
        const device = mine.find(d => d.credential_id === body.assertion.id);
        const challenge = await takeChallenge(db, user.id, 'verify');
        if (!device) return blocked('NOT_YOUR_LAPTOP', 'This isn’t your registered laptop. Clock in from your own work laptop.');
        if (!challenge) return blocked('LAPTOP_CHECK', 'The laptop check took too long. Please try again.');
        try {
          const result = await verifyAuthenticationResponse({
            response: body.assertion,
            expectedChallenge: challenge,
            expectedOrigin: origin!,
            expectedRPID: rpID,
            credential: {
              id: device.credential_id,
              publicKey: isoBase64URL.toBuffer(device.public_key),
              counter: Number(device.counter),
              transports: device.transports ?? undefined
            },
            requireUserVerification: true
          });
          if (!result.verified) return blocked('NOT_YOUR_LAPTOP', 'The laptop check didn’t pass. Clock in from your own work laptop.');
          await db.from('devices').update({
            counter: result.authenticationInfo.newCounter,
            last_used_at: new Date().toISOString()
          }).eq('id', device.id);
        } catch {
          return blocked('NOT_YOUR_LAPTOP', 'The laptop check didn’t pass. Clock in from your own work laptop.');
        }
        deviceVerified = true;
        deviceId = device.id;
        laptopPending = device.status === 'pending';
        if (laptopPending) flag('device_pending', 'low', { device: device.label });
      }

      // this browser registered as someone else's laptop
      if (deviceKey) {
        const { data: theirs } = await db
          .from('devices').select('id').eq('device_key', deviceKey).neq('user_id', user.id).neq('status', 'revoked').limit(1);
        if (theirs?.length) {
          return blocked('NOT_YOUR_LAPTOP', 'This laptop is registered to someone else. Clock in from your own work laptop.');
        }
      }

      // office network: internet address, and the Wi-Fi name if the desktop
      // app is running. Blocks only when Settings says office only.
      const ip = trustedIp(req);
      let networkId: string | null = null;
      let onOfficeNetwork: boolean | null = null;
      const { data: networks } = await db.from('office_networks').select('id, label, ip');
      if (networks?.length && ip) {
        const match = networks.find(n => n.ip === ip);
        networkId = match?.id ?? null;
        onOfficeNetwork = !!match;
      }
      let wifiName: string | null = null;
      let onOfficeWifi: boolean | null = null;
      const { data: beat } = await db
        .from('heartbeats').select('wifi_name, desktop_seen_at').eq('user_id', user.id).maybeSingle();
      if (beat?.desktop_seen_at && Date.now() - new Date(beat.desktop_seen_at).getTime() < 10 * 60 * 1000) {
        wifiName = beat.wifi_name ?? null;
        const officeWifi: string[] = settings?.office_wifi_names ?? [];
        if (wifiName && officeWifi.length) onOfficeWifi = officeWifi.includes(wifiName);
      }
      const outageToday = settings?.network_outage_on === todayGhana();
      const offNetwork = onOfficeNetwork === false || onOfficeWifi === false;
      if (settings?.network_mode === 'office_only' && !outageToday && onOfficeNetwork !== true) {
        if (!networks?.length) {
          return blocked('OFF_NETWORK', 'Clocking in is set to the office network only, but no office network has been added yet. Ask your admin.');
        }
        if (onOfficeNetwork === null || offNetwork) {
          return blocked('OFF_NETWORK', 'You’re not on the office network, so you can’t clock in from here. Connect to the office network and try again.');
        }
      }
      if (!outageToday && offNetwork) {
        flag('off_network', 'low', {
          ip: onOfficeNetwork === false ? ip : undefined,
          wifi: onOfficeWifi === false ? wifiName : undefined
        });
      }

      // same browser used by another account recently (recorded)
      if (deviceKey) {
        const since = new Date(Date.now() - SAME_DEVICE_HOURS * 3600 * 1000).toISOString();
        const { data: others } = await db
          .from('clock_evidence').select('user_id, session_id, created_at')
          .eq('device_key', deviceKey).neq('user_id', user.id).gte('created_at', since);
        const seen = new Set<string>();
        for (const o of others ?? []) {
          if (seen.has(o.user_id)) continue;
          seen.add(o.user_id);
          flag('same_device', 'high', { other_user_id: o.user_id, other_session_id: o.session_id, other_at: o.created_at });
        }
      }

      // all good: start the session
      const locationStatus = ['authorised', 'unauthorised', 'unavailable'].includes(body.locationStatus)
        ? body.locationStatus
        : 'unavailable';
      const { error: startError } = await db.from('employee_status').upsert({
        user_id: user.id,
        status: 'clocked_in',
        clock_in_at: clockInAt.toISOString(),
        break_started_at: null,
        break_accum_seconds: 0,
        location_status: body.clockInAt ? 'unavailable' : locationStatus,
        paused_for_check: false,
        held_for_laptop: laptopPending,
        held_device_id: laptopPending ? deviceId : null,
        break_2h_sent: false,
        break_3h_sent: false,
        clock_out_8h_sent: false,
        auto_clock_out_sent: false,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });
      if (startError) throw startError;
      const { data: started } = await db
        .from('employee_status').select('*').eq('user_id', user.id).maybeSingle();
      const sessionId = started?.session_id;
      if (!sessionId) return json({ error: 'The session couldn’t be started. Please try again.' }, 500);

      const photoPath = freshPhoto(body.photoPath, user.id, 'clockin', Date.now() - 10 * 60000);
      await db.from('clock_evidence').insert({
        user_id: user.id,
        session_id: sessionId,
        kind: 'clock_in',
        device_id: deviceId,
        device_verified: deviceVerified,
        device_key: deviceKey,
        ip: ip ?? callerIp(req),
        network_id: networkId,
        on_office_network: onOfficeNetwork,
        location_status: started.location_status,
        face_result: faceResult,
        face_distance: faceDistance,
        face_attempts: Number.isInteger(face.attempts) ? face.attempts : null,
        blink_passed: typeof face.blink === 'boolean' ? face.blink : null,
        photo_path: photoPath,
        user_agent: (body.clockInAt ? `Offline clock-in, sent ${new Date().toISOString()} · ` : '') + (req.headers.get('user-agent') ?? '').slice(0, 260),
        wifi_name: wifiName
      });

      if (flags.length) {
        await db.from('session_flags').insert(flags.map(f => ({
          user_id: user.id, session_id: sessionId, type: f.type, severity: f.severity, details: f.details
        })));
      }
      // other account on this browser: their session gets it too
      for (const f of flags.filter(x => x.type === 'same_device')) {
        await db.from('session_flags').insert({
          user_id: f.details.other_user_id,
          session_id: f.details.other_session_id,
          type: 'same_device',
          severity: 'high',
          details: { other_user_id: user.id, other_session_id: sessionId, other_at: new Date().toISOString() }
        });
      }

      // checks from now on (an offline clock-in doesn't get ones in the past)
      await schedulePresenceChecks(db, user.id, sessionId, body.clockInAt ? new Date() : clockInAt, settings);

      return json({
        ok: true,
        status: started,
        faceResult,
        laptopPending,
        flags: flags.map(f => f.type)
      });
    }

    // ---------- back from a pause (missed presence check) ----------
    // Face again; not matching after 3 tries still lets them carry on but
    // goes to Review. The pause counts as a break.
    if (action === 'resume') {
      const { data: status } = await db
        .from('employee_status').select('*').eq('user_id', user.id).maybeSingle();
      if (!status || status.status !== 'on_break' || !status.paused_for_check) {
        return json({ ok: true, notPaused: true });
      }
      const { data: settings } = await db.from('security_settings').select('face_check_enabled').eq('id', 1).maybeSingle();
      const face = body.face ?? {};
      if (settings?.face_check_enabled !== false) {
        const { data: profile } = await db
          .from('face_profiles').select('descriptor, status').eq('user_id', user.id).maybeSingle();
        if (profile?.status !== 'approved') {
          return blocked('FACE_SETUP', 'Your face check isn’t set up, so you can’t carry on. Set it up in Devices & Security, or ask your admin.');
        }
        {
          if (face.noFace || !validDescriptor(face.descriptor)) {
            return blocked('NO_FACE', 'No face was seen. Face the camera in good light and try again.');
          }
          const d = distance(face.descriptor, profile.descriptor);
          const tries = Number.isInteger(face.attempts) ? face.attempts : 1;
          if (d >= FACE_MATCH && tries < FACE_TRIES) {
            return blocked('FACE_RETRY', 'That didn’t pass. Please try the face check again.');
          }
          if (d >= FACE_MATCH) {
            await db.from('session_flags').insert({
              user_id: user.id,
              session_id: status.session_id,
              type: 'face_failed',
              severity: 'high',
              details: { reason: 'Face did not match when coming back from a pause', distance: round(d), attempts: tries }
            });
          }
        }
      }
      const pausedFor = status.break_started_at
        ? Math.max(0, Math.round((Date.now() - new Date(status.break_started_at).getTime()) / 1000))
        : 0;
      // only if still paused (not clocked out by the sweep meanwhile)
      const { data: resumed } = await db.from('employee_status').update({
        status: 'clocked_in',
        break_started_at: null,
        break_accum_seconds: (status.break_accum_seconds || 0) + pausedFor,
        paused_for_check: false,
        updated_at: new Date().toISOString()
      }).eq('user_id', user.id).eq('status', 'on_break').eq('paused_for_check', true).select('user_id');
      const { data: after } = await db.from('employee_status').select('*').eq('user_id', user.id).maybeSingle();
      if (!resumed?.length) return json({ ok: true, notPaused: true, status: after });
      return json({ ok: true, status: after });
    }

    // ---------- clock out ----------
    // Hours worked out here from the session (a break or pause still going
    // isn't counted) and saved as the record; the browser can't write records.
    if (action === 'clock-out') {
      const { data: status } = await db
        .from('employee_status').select('*').eq('user_id', user.id).maybeSingle();
      if (!status || !['clocked_in', 'on_break'].includes(status.status)) return json({ ok: true, notLive: true });
      const now = new Date();
      const clockInAt = status.clock_in_at ? new Date(status.clock_in_at) : now;
      const workEnd = status.status === 'on_break' && status.break_started_at ? new Date(status.break_started_at) : now;
      const worked = Math.max(0, Math.round((workEnd.getTime() - clockInAt.getTime()) / 1000) - (status.break_accum_seconds || 0));
      const { error: recordError } = await db.from('records').insert([{
        user_id: user.id,
        date: ghanaDate(now),
        clock_in: ghanaClock(clockInAt),
        clock_out: ghanaClock(now),
        hours_worked: hms(worked),
        break_time: hms(status.break_accum_seconds || 0),
        location_status: status.location_status || 'unavailable',
        adjusted_by_admin: false
      }]);
      if (recordError) throw recordError;
      await db.from('employee_status').update({
        status: 'clocked_out',
        clock_in_at: null,
        break_started_at: null,
        break_accum_seconds: 0,
        location_status: null,
        paused_for_check: false,
        held_for_laptop: false,
        held_device_id: null,
        updated_at: now.toISOString()
      }).eq('user_id', user.id);
      return json({ ok: true, worked });
    }

    // ---------- face try (between attempts, nothing saved) ----------
    if (action === 'face-try') {
      if (!validDescriptor(body.descriptor)) return json({ match: false });
      const { data: profile } = await db
        .from('face_profiles').select('descriptor, status').eq('user_id', user.id).maybeSingle();
      if (profile?.status !== 'approved') return json({ match: false, registered: false });
      return json({ match: distance(body.descriptor, profile.descriptor) < FACE_MATCH, registered: true });
    }

    // ---------- answer a presence check ----------
    if (action === 'presence') {
      const { data: check } = await db
        .from('presence_checks').select('*').eq('id', body.checkId).eq('user_id', user.id).maybeSingle();
      if (!check) return json({ error: 'Check not found' }, 404);
      const now = Date.now();
      if (check.result !== 'pending' || now < new Date(check.due_at).getTime() || now > new Date(check.expires_at).getTime()) {
        return json({ error: 'This check is no longer open' }, 400);
      }
      // only for the session that's running now
      const { data: live } = await db
        .from('employee_status').select('status, session_id').eq('user_id', user.id).maybeSingle();
      if (!live || !['clocked_in', 'on_break'].includes(live.status) || live.session_id !== check.session_id) {
        return json({ error: 'This check is no longer open' }, 400);
      }

      // nobody in front of the camera = same as not answering: time paused
      if (!validDescriptor(body.descriptor)) {
        const { data: marked } = await db.from('presence_checks').update({
          result: 'missed',
          responded_at: new Date().toISOString(),
          answered_from: body.from === 'desktop' ? 'desktop' : 'web'
        }).eq('id', check.id).eq('result', 'pending').select('id');
        if (!marked?.length) return json({ error: 'This check is no longer open' }, 400);
        if (live.status === 'clocked_in') await pauseForCheck(db, user.id, check.due_at);
        return json({ result: 'missed', paused: live.status === 'clocked_in' });
      }

      let result = 'failed';
      let faceDistance: number | null = null;
      const { data: profile } = await db
        .from('face_profiles').select('descriptor, status').eq('user_id', user.id).maybeSingle();
      const { data: faceSetting } = await db.from('security_settings').select('face_check_enabled').eq('id', 1).maybeSingle();
      if (faceSetting?.face_check_enabled === false) {
        result = 'passed';       // face check off: someone answered
      } else if (profile?.status === 'approved') {
        faceDistance = distance(body.descriptor, profile.descriptor);
        result = faceDistance < FACE_MATCH ? 'passed' : 'failed';
      }

      const photoPath = freshPhoto(body.photoPath, user.id, 'presence', new Date(check.due_at).getTime());
      const { data: saved } = await db.from('presence_checks').update({
        result,
        responded_at: new Date().toISOString(),
        face_distance: faceDistance,
        photo_path: photoPath,
        answered_from: body.from === 'desktop' ? 'desktop' : 'web'
      }).eq('id', check.id).eq('result', 'pending').select('id');
      // answered from the other app (or marked missed) a moment ago
      if (!saved?.length) return json({ error: 'This check is no longer open' }, 400);

      if (result === 'failed') {
        await db.from('session_flags').insert({
          user_id: user.id,
          session_id: check.session_id,
          type: 'presence_failed',
          severity: 'high',
          details: { check_id: check.id, due_at: check.due_at, distance: faceDistance === null ? null : round(faceDistance), reason: faceDistance === null ? 'No face check set up to compare with' : 'Face did not match' }
        });
      }
      return json({ result });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message ?? 'Something went wrong' }, 500);
  }
});

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}

// missed presence check: time stops from when it was asked (counted as a
// break) until they're back with a face check ('resume' above)
// deno-lint-ignore no-explicit-any
async function pauseForCheck(db: any, userId: string, fromIso: string) {
  // a break taken after the check was asked is already off the clock
  const { data: lastBreak } = await db
    .from('breaks').select('ended_at').eq('user_id', userId).gte('ended_at', fromIso)
    .order('ended_at', { ascending: false }).limit(1);
  const from = lastBreak?.[0]?.ended_at && lastBreak[0].ended_at > fromIso ? lastBreak[0].ended_at : fromIso;
  await db.from('employee_status').update({
    status: 'on_break',
    break_started_at: from,
    paused_for_check: true,
    updated_at: new Date().toISOString()
  }).eq('user_id', userId).eq('status', 'clocked_in');
  await db.from('breaks').update({ reason: 'missed_check' })
    .eq('user_id', userId).is('ended_at', null);
}

// one-time challenge: read it and delete it, only if it's recent
// deno-lint-ignore no-explicit-any
async function takeChallenge(db: any, userId: string, purpose: 'register' | 'verify'): Promise<string | null> {
  const { data } = await db
    .from('webauthn_challenges').select('id, challenge, created_at')
    .eq('user_id', userId).eq('purpose', purpose)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  await db.from('webauthn_challenges').delete().eq('id', data.id);
  if (Date.now() - new Date(data.created_at).getTime() > CHALLENGE_MINUTES * 60 * 1000) return null;
  return data.challenge;
}

// spread the checks over the working day, one in each slot at a random time,
// so nobody can predict them
// deno-lint-ignore no-explicit-any
async function schedulePresenceChecks(db: any, userId: string, sessionId: string, clockIn: Date, settings: any) {
  const count = Math.max(0, Math.min(12, Number(settings?.presence_checks_per_session ?? 4)));
  const windowMin = Math.max(1, Math.min(30, Number(settings?.presence_window_minutes ?? 5)));
  if (!count) return;

  const usable = WORKDAY_MINUTES - FIRST_CHECK_AFTER;
  const slot = usable / count;
  const rows = [];
  for (let i = 0; i < count; i++) {
    const offset = FIRST_CHECK_AFTER + slot * i + Math.random() * Math.max(1, slot - windowMin);
    const due = new Date(clockIn.getTime() + offset * 60 * 1000);
    rows.push({
      user_id: userId,
      session_id: sessionId,
      due_at: due.toISOString(),
      expires_at: new Date(due.getTime() + windowMin * 60 * 1000).toISOString()
    });
  }
  await db.from('presence_checks').insert(rows);
}
