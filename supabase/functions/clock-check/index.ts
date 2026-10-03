// supabase/functions/clock-check/index.ts
//
// The checks behind a clock-in. Everything that decides whether a session gets
// flagged runs here, not in the browser:
//   register-options / register-verify   register a work laptop (passkey)
//   auth-options                         passkey challenge before clocking in
//   clock-in                             laptop, face, network and same-laptop
//                                        checks, saved as evidence + flags,
//                                        then the presence checks are scheduled
//   face-try                             does this face match? (between tries, nothing saved)
//   presence                             answer a presence check (face matched here)
//   offline-clock-in                     a clock-in saved while the laptop was offline,
//                                        sent once it's back (flagged for the admin)
//   my-ip                                the internet address the request came from
//                                        (admin "add the network I'm on now")
//
// Nothing here blocks a clock-in. Anything that doesn't add up becomes a flag
// for the admin's Review page.
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
  const direct = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip');
  if (direct) return direct.trim();
  const fwd = req.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : null;
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
      const { data: device, error } = await db.from('devices').insert({
        user_id: user.id,
        label,
        credential_id: credential.id,
        public_key: isoBase64URL.fromBuffer(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports ?? null,
        device_key: typeof body.deviceKey === 'string' ? body.deviceKey.slice(0, 64) : null,
        synced: credentialBackedUp,
        status: 'pending'
      }).select('id, label, status, created_at, synced').single();
      if (error) throw error;
      return json({ device });
    }

    // ---------- passkey challenge before clocking in ----------
    if (action === 'auth-options') {
      const { data: devices } = await db
        .from('devices').select('credential_id, transports')
        .eq('user_id', user.id).eq('status', 'approved');
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

    // ---------- clock-in checks ----------
    if (action === 'clock-in') {
      const { data: status } = await db
        .from('employee_status').select('status, session_id, clock_in_at, location_status')
        .eq('user_id', user.id).maybeSingle();
      if (!status?.session_id || !['clocked_in', 'on_break'].includes(status.status)) {
        return json({ error: 'No session running' }, 400);
      }
      if (Date.now() - new Date(status.clock_in_at).getTime() > 15 * 60 * 1000) {
        return json({ error: 'Checks have to be sent straight after clocking in' }, 400);
      }
      const sessionId = status.session_id;

      // sent twice (double tap, retry)? keep the first
      const { data: already } = await db
        .from('clock_evidence').select('id').eq('session_id', sessionId).eq('kind', 'clock_in').maybeSingle();
      if (already) return json({ ok: true, repeated: true });

      const { data: settings } = await db.from('security_settings').select('*').eq('id', 1).maybeSingle();
      const flags: { type: string; severity: string; details: Record<string, unknown> }[] = [];
      const flag = (type: string, severity: string, details: Record<string, unknown> = {}) =>
        flags.push({ type, severity, details });

      // laptop
      let deviceVerified = false;
      let deviceId: string | null = null;
      const { data: approved } = await db
        .from('devices').select('*').eq('user_id', user.id).eq('status', 'approved');

      if (!approved?.length) {
        if (settings?.require_registered_device !== false) {
          flag('device_unregistered', 'medium', { note: 'No approved work laptop yet' });
        }
      } else if (!body.assertion) {
        flag('device_not_verified', 'high', { reason: body.passkeyError || 'Passkey check not done' });
      } else {
        const device = approved.find(d => d.credential_id === body.assertion.id);
        const challenge = await takeChallenge(db, user.id, 'verify');
        if (!device || !challenge) {
          flag('device_not_verified', 'high', { reason: !device ? 'Not one of their approved laptops' : 'Passkey check expired' });
        } else {
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
            deviceVerified = result.verified;
            deviceId = device.id;
            if (result.verified) {
              await db.from('devices').update({
                counter: result.authenticationInfo.newCounter,
                last_used_at: new Date().toISOString()
              }).eq('id', device.id);
            } else {
              flag('device_not_verified', 'high', { reason: 'Passkey did not verify', device: device.label });
            }
          } catch (e) {
            flag('device_not_verified', 'high', { reason: (e as Error).message, device: device.label });
          }
        }
      }

      // office network: internet address, and the Wi-Fi name if the desktop
      // app is running (second signal). Either one off = flagged.
      const ip = callerIp(req);
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
      if (!outageToday && (onOfficeNetwork === false || onOfficeWifi === false)) {
        flag('off_network', 'low', {
          ip: onOfficeNetwork === false ? ip : undefined,
          wifi: onOfficeWifi === false ? wifiName : undefined
        });
      }

      // face
      let faceResult: string = 'skipped';
      let faceDistance: number | null = null;
      const face = body.face ?? {};
      if (settings?.face_check_enabled !== false) {
        const { data: profile } = await db
          .from('face_profiles').select('descriptor, status').eq('user_id', user.id).maybeSingle();
        if (!profile || profile.status !== 'approved') {
          faceResult = 'not_registered';
          // had a face and withdrew it: worth a closer look than never set up
          flag('face_not_registered', profile?.status === 'withdrawn' ? 'medium' : 'low', { status: profile?.status ?? 'none' });
        } else if (face.noFace || !validDescriptor(face.descriptor)) {
          faceResult = 'no_face';
          flag('face_failed', 'high', { reason: 'No face seen', attempts: face.attempts ?? null });
        } else {
          faceDistance = distance(face.descriptor, profile.descriptor);
          faceResult = faceDistance < FACE_MATCH ? 'match' : 'no_match';
          if (faceResult === 'no_match') {
            flag('face_failed', 'high', { reason: 'Face did not match', distance: round(faceDistance), attempts: face.attempts ?? null });
          } else if (face.blink !== true) {
            flag('face_failed', 'medium', { reason: 'Face matched but no blink was seen (could be a photo)', distance: round(faceDistance) });
          }
        }
      }

      // same laptop used by someone else today
      const deviceKey = typeof body.deviceKey === 'string' ? body.deviceKey.slice(0, 64) : null;
      if (deviceKey) {
        const since = new Date(Date.now() - SAME_DEVICE_HOURS * 3600 * 1000).toISOString();
        const { data: others } = await db
          .from('clock_evidence').select('user_id, session_id, created_at')
          .eq('device_key', deviceKey).neq('user_id', user.id).gte('created_at', since);
        // one flag per colleague, their latest session
        const latest = new Map<string, { user_id: string; session_id: string; created_at: string }>();
        for (const o of others ?? []) {
          const seen = latest.get(o.user_id);
          if (!seen || o.created_at > seen.created_at) latest.set(o.user_id, o);
        }
        for (const other of latest.values()) {
          flag('same_device', 'high', { other_user_id: other.user_id, other_session_id: other.session_id, other_at: other.created_at });
          await db.from('session_flags').insert({
            user_id: other.user_id,
            session_id: other.session_id,
            type: 'same_device',
            severity: 'high',
            details: { other_user_id: user.id, other_session_id: sessionId, other_at: new Date().toISOString() }
          });
        }
      }

      const photoPath = freshPhoto(body.photoPath, user.id, 'clockin', new Date(status.clock_in_at).getTime() - 10 * 60000);

      const { error: evidenceError } = await db.from('clock_evidence').insert({
        user_id: user.id,
        session_id: sessionId,
        kind: 'clock_in',
        device_id: deviceId,
        device_verified: deviceVerified,
        device_key: deviceKey,
        ip,
        network_id: networkId,
        on_office_network: onOfficeNetwork,
        location_status: status.location_status,
        face_result: faceResult,
        face_distance: faceDistance,
        face_attempts: Number.isInteger(face.attempts) ? face.attempts : null,
        blink_passed: typeof face.blink === 'boolean' ? face.blink : null,
        photo_path: photoPath,
        user_agent: (req.headers.get('user-agent') ?? '').slice(0, 300),
        wifi_name: wifiName
      });
      if (evidenceError) {
        // sent twice at the same moment: the first one already saved it
        if ((evidenceError as { code?: string }).code === '23505') return json({ ok: true, repeated: true });
        throw evidenceError;
      }

      if (flags.length) {
        await db.from('session_flags').insert(flags.map(f => ({
          user_id: user.id, session_id: sessionId, type: f.type, severity: f.severity, details: f.details
        })));
      }

      await schedulePresenceChecks(db, user.id, sessionId, new Date(status.clock_in_at), settings);

      return json({ ok: true, deviceVerified, faceResult, flags: flags.map(f => f.type) });
    }

    // ---------- clock-in made while offline, sent now ----------
    if (action === 'offline-clock-in') {
      const claimed = new Date(String(body.clockInAt || ''));
      const now = Date.now();
      if (Number.isNaN(claimed.getTime()) || claimed.getTime() > now + 60000 || claimed.getTime() < now - 6 * 3600000) {
        return json({ error: 'That offline clock-in is too old to send. Ask your admin to add it.' }, 400);
      }
      const { data: current } = await db
        .from('employee_status').select('status').eq('user_id', user.id).maybeSingle();
      if (current && ['clocked_in', 'on_break'].includes(current.status)) {
        return json({ ok: true, alreadyLive: true });
      }

      await db.from('employee_status').upsert({
        user_id: user.id,
        status: 'clocked_in',
        clock_in_at: claimed.toISOString(),
        break_started_at: null,
        break_accum_seconds: 0,
        location_status: 'unavailable',
        break_2h_sent: false,
        break_3h_sent: false,
        clock_out_8h_sent: false,
        auto_clock_out_sent: false,
        updated_at: new Date().toISOString()
      });
      const { data: started } = await db
        .from('employee_status').select('session_id').eq('user_id', user.id).maybeSingle();
      const sessionId = started?.session_id;
      if (!sessionId) return json({ error: 'Couldn’t start the session' }, 500);

      await db.from('clock_evidence').insert({
        user_id: user.id,
        session_id: sessionId,
        kind: 'clock_in',
        device_key: typeof body.deviceKey === 'string' ? body.deviceKey.slice(0, 64) : null,
        ip: callerIp(req),
        location_status: 'unavailable',
        face_result: 'skipped',
        user_agent: `Offline clock-in, sent ${new Date().toISOString()}`
      });
      await db.from('session_flags').insert({
        user_id: user.id,
        session_id: sessionId,
        type: 'offline_clock_in',
        severity: 'medium',
        details: {
          claimed_at: claimed.toISOString(),
          sent_at: new Date().toISOString(),
          minutes_late: Math.round((now - claimed.getTime()) / 60000)
        }
      });
      const { data: settings } = await db.from('security_settings').select('*').eq('id', 1).maybeSingle();
      // checks from now on, not from the (past) clock-in time
      await schedulePresenceChecks(db, user.id, sessionId, new Date(), settings);
      return json({ ok: true });
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

      let result = 'failed';
      let faceDistance: number | null = null;
      const { data: profile } = await db
        .from('face_profiles').select('descriptor, status').eq('user_id', user.id).maybeSingle();
      if (validDescriptor(body.descriptor)) {
        if (profile?.status === 'approved') {
          faceDistance = distance(body.descriptor, profile.descriptor);
          result = faceDistance < FACE_MATCH ? 'passed' : 'failed';
        } else {
          result = 'passed';     // someone was there; no approved face to compare with
        }
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
          details: { check_id: check.id, due_at: check.due_at, distance: faceDistance === null ? null : round(faceDistance), reason: faceDistance === null ? 'No face seen' : 'Face did not match' }
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
