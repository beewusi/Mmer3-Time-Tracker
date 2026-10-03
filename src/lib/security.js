import { startRegistration, startAuthentication, browserSupportsWebAuthn, platformAuthenticatorIsAvailable } from '@simplewebauthn/browser';
import { supabase } from '../supabase';

// Clock-in checks: work laptop passkey, face, evidence photos.
// Everything that decides a flag happens in the clock-check function.

const DEVICE_KEY = 'mmer3-device-key';

// Random id kept in this browser. Same id on two accounts = same laptop.
export function getDeviceKey() {
  try {
    let key = localStorage.getItem(DEVICE_KEY);
    if (!key) {
      key = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
      localStorage.setItem(DEVICE_KEY, key);
    }
    return key;
  } catch {
    return null;
  }
}

export async function callClockCheck(action, payload = {}) {
  const { data, error } = await supabase.functions.invoke('clock-check', {
    body: { action, ...payload }
  });
  if (error) {
    let message = error.message || 'The check couldn’t be completed.';
    if (error.context && typeof error.context.json === 'function') {
      try {
        const body = await error.context.json();
        if (body?.error) message = body.error;
      } catch {
        // not JSON, keep the generic one
      }
    }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function loadSecuritySettings() {
  const { data } = await supabase.from('security_settings').select('*').eq('id', 1).maybeSingle();
  return data || {
    require_registered_device: true,
    face_check_enabled: true,
    presence_checks_per_session: 4,
    presence_window_minutes: 5,
    screenshots_per_hour: 3,
    network_outage_on: null
  };
}

// ---------- laptop (passkey) ----------

export async function passkeysSupported() {
  if (!browserSupportsWebAuthn()) return false;
  try {
    return await platformAuthenticatorIsAvailable();
  } catch {
    return false;
  }
}

export async function listMyDevices(userId) {
  const { data } = await supabase
    .from('devices')
    .select('id, label, status, created_at, approved_at, last_used_at, synced, device_key')
    .eq('user_id', userId)
    .neq('status', 'revoked')
    .order('created_at', { ascending: false });
  return data || [];
}

export async function registerThisLaptop(label) {
  const { options } = await callClockCheck('register-options');
  let response;
  try {
    response = await startRegistration({ optionsJSON: options });
  } catch (err) {
    throw new Error(passkeyErrorText(err, 'register'));
  }
  const { device } = await callClockCheck('register-verify', { response, label, deviceKey: getDeviceKey() });
  return device;
}

export async function removeDevice(id) {
  const { error } = await supabase.from('devices').delete().eq('id', id);
  if (error) throw error;
}

// Passkey prompt before clocking in. Never throws: a failure is sent to
// clock-check as the reason and the session is flagged.
export async function getClockInAssertion() {
  try {
    const { options } = await callClockCheck('auth-options');
    if (!options) return { assertion: null, error: null, hasDevice: false };
    const assertion = await startAuthentication({ optionsJSON: options });
    return { assertion, error: null, hasDevice: true };
  } catch (err) {
    return { assertion: null, error: passkeyErrorText(err, 'verify'), hasDevice: true };
  }
}

function passkeyErrorText(err, kind) {
  const name = err?.name || err?.cause?.name;
  if (name === 'NotAllowedError') {
    return kind === 'register'
      ? 'Registration was cancelled or timed out.'
      : 'The laptop check was cancelled or timed out.';
  }
  if (name === 'InvalidStateError') return 'This laptop is already registered to your account.';
  if (name === 'SecurityError') return 'Passkeys don’t work on this site address.';
  return err?.message || 'The laptop check didn’t work.';
}

// ---------- face ----------

export async function getMyFaceProfile() {
  const { data } = await supabase.rpc('my_face_profile');
  return Array.isArray(data) ? data[0] || null : data || null;
}

export async function faceRegisteredToOther(descriptor) {
  const { data, error } = await supabase.rpc('face_registered_to_other', { probe: descriptor });
  if (error) throw error;
  return data || null;
}

// New or replaced face, saved by the database function (it also checks the
// face isn't someone else's). Goes to the admin as pending.
export async function saveFaceProfile(userId, descriptor, photoBlob) {
  const photoPath = await uploadEvidence(userId, 'face', photoBlob);
  if (!photoPath) throw new Error('The photo couldn’t be saved. Please try again.');
  const { error } = await supabase.rpc('save_face_profile', {
    probe: descriptor,
    photo: photoPath,
    version: FACE_CONSENT_VERSION
  });
  if (error) {
    await supabase.storage.from('evidence').remove([photoPath]);
    const taken = /FACE_TAKEN:(.*)/.exec(error.message || '');
    if (/FACE_LOCKED/.test(error.message || '')) throw new Error('Your face is already approved. Ask your admin if you need to change the photo.');
    if (taken) throw new Error(`This face is already registered to another account (${taken[1].trim()}). Each person can only register their own face.`);
    throw new Error(error.message || 'Couldn’t save your face.');
  }
}

// Numbers and photo deleted; the row stays as "withdrawn"
export async function withdrawFaceConsent() {
  const { data: oldPhoto, error } = await supabase.rpc('withdraw_face_consent');
  if (error) throw error;
  if (oldPhoto) await supabase.storage.from('evidence').remove([oldPhoto]);
}

export const FACE_CONSENT_VERSION = '2026-10-03';

// Is this the right person? Used between tries; the real decision is made
// again in clock-check.
export async function faceMatches(descriptor) {
  const { match } = await callClockCheck('face-try', { descriptor });
  return !!match;
}

// ---------- photos ----------

export async function uploadEvidence(userId, kind, blob) {
  if (!blob) return null;
  const path = `${userId}/${kind}-${Date.now()}.jpg`;
  const { error } = await supabase.storage.from('evidence').upload(path, blob, {
    contentType: 'image/jpeg',
    upsert: false
  });
  if (error) {
    console.log('Photo upload failed:', error.message);
    return null;
  }
  return path;
}

export async function signedPhotoUrl(path, bucket = 'evidence') {
  if (!path) return null;
  const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 10);
  return data?.signedUrl || null;
}
