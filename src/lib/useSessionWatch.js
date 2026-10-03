import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from '../supabase';
import { callClockCheck, uploadEvidence } from './security';

// While clocked in: heartbeats (so gaps in contact show up), away time from
// the browser's Idle Detection (Chrome/Edge), and presence checks.

const HEARTBEAT_MS = 60 * 1000;
const IDLE_THRESHOLD_MS = 60 * 1000;   // smallest the browser allows
const IDLE_LOG_MINUTES = 10;           // shorter idle spells aren't worth keeping
const AWAY_FLAG_MINUTES = 30;          // longer than this goes to the admin

export function idleDetectionSupported() {
  return typeof window !== 'undefined' && 'IdleDetector' in window;
}

// Has to run inside the click (needs the user gesture), so it's called at the
// very start of Clock In and not awaited there.
export function askIdlePermission() {
  if (!idleDetectionSupported()) return;
  try {
    window.IdleDetector.requestPermission().catch(() => {});
  } catch {
    // older browser, nothing to do
  }
}

async function currentSessionId(userId) {
  const { data } = await supabase.from('employee_status').select('session_id').eq('user_id', userId).maybeSingle();
  return data?.session_id || null;
}

export function useSessionWatch(user, isClockedIn) {
  const idleStateRef = useRef('active');

  // heartbeat
  useEffect(() => {
    if (!user || !isClockedIn) return undefined;
    const beat = () => supabase.from('heartbeats').upsert({
      user_id: user.id,
      source: 'web',
      idle_state: idleStateRef.current
    }).then(() => {}, () => {});
    beat();
    const t = setInterval(beat, HEARTBEAT_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') beat(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [user, isClockedIn]);

  // away time
  useEffect(() => {
    if (!user || !isClockedIn || !idleDetectionSupported()) return undefined;
    let detector = null;
    const controller = new AbortController();
    let idleSince = null;
    let idleKind = null;

    (async () => {
      try {
        const permission = await navigator.permissions.query({ name: 'idle-detection' }).catch(() => null);
        if (permission && permission.state !== 'granted') return;
        detector = new window.IdleDetector();
        detector.addEventListener('change', async () => {
          const locked = detector.screenState === 'locked';
          const idle = detector.userState === 'idle';
          const state = locked ? 'locked' : idle ? 'idle' : 'active';
          idleStateRef.current = state;

          if (state !== 'active' && !idleSince) {
            // the browser only says "idle" after the threshold, so it started then
            idleSince = new Date(Date.now() - (locked ? 0 : IDLE_THRESHOLD_MS));
            idleKind = locked ? 'locked' : 'idle';
          } else if (state === 'active' && idleSince) {
            const started = idleSince;
            const kind = idleKind;
            idleSince = null;
            idleKind = null;
            await recordAway(user.id, kind, started, new Date());
          }
        });
        await detector.start({ threshold: IDLE_THRESHOLD_MS, signal: controller.signal });
      } catch {
        // permission refused or not available: the desktop app covers it
      }
    })();

    return () => {
      controller.abort();
      if (idleSince) recordAway(user.id, idleKind, idleSince, new Date());
    };
  }, [user, isClockedIn]);
}

export async function recordAway(userId, kind, started, ended, source = 'web') {
  const minutes = (ended - started) / 60000;
  if (minutes < IDLE_LOG_MINUTES) return;
  const sessionId = await currentSessionId(userId);
  await supabase.from('activity_events').insert({
    user_id: userId,
    session_id: sessionId,
    type: kind,
    started_at: started.toISOString(),
    ended_at: ended.toISOString(),
    source
  });
  if (minutes >= AWAY_FLAG_MINUTES) {
    await supabase.from('session_flags').insert({
      user_id: userId,
      session_id: sessionId,
      type: 'away',
      severity: minutes >= 90 ? 'medium' : 'low',
      details: { minutes: Math.round(minutes), from: started.toISOString(), to: ended.toISOString(), kind, source }
    });
  }
}

// Presence checks due now. Returns the open one (if any) and how to answer it.
export function usePresenceChecks(user, isClockedIn, from = 'web') {
  const [openCheck, setOpenCheck] = useState(null);
  const notifiedRef = useRef(new Set());

  const refresh = useCallback(async () => {
    if (!user || !isClockedIn) { setOpenCheck(null); return; }
    const nowIso = new Date().toISOString();
    const { data } = await supabase
      .from('presence_checks')
      .select('id, due_at, expires_at, result')
      .eq('user_id', user.id)
      .eq('result', 'pending')
      .lte('due_at', nowIso)
      .gte('expires_at', nowIso)
      .order('due_at', { ascending: true })
      .limit(1);
    const check = data?.[0] || null;
    setOpenCheck(check);
    if (check && !notifiedRef.current.has(check.id)) {
      notifiedRef.current.add(check.id);
      // tab hidden, or the browser is behind other windows
      if ('Notification' in window && Notification.permission === 'granted' && (document.visibilityState !== 'visible' || !document.hasFocus())) {
        try {
          new Notification('Presence check', { body: 'Show your face in Mmerℇ within 5 minutes.', tag: `presence-${check.id}` });
        } catch {
          // some browsers only allow notifications from the service worker
        }
      }
    }
  }, [user, isClockedIn]);

  useEffect(() => {
    if (!user || !isClockedIn) { setOpenCheck(null); return undefined; }
    refresh();
    const t = setInterval(refresh, 20000);
    const channel = supabase
      .channel(`presence-${user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'presence_checks', filter: `user_id=eq.${user.id}` }, refresh)
      .subscribe();
    return () => {
      clearInterval(t);
      supabase.removeChannel(channel);
    };
  }, [user, isClockedIn, refresh]);

  const answer = useCallback(async (check, faceResult) => {
    const photoPath = faceResult?.photoBlob ? await uploadEvidence(user.id, 'presence', faceResult.photoBlob) : null;
    const res = await callClockCheck('presence', {
      checkId: check.id,
      descriptor: faceResult?.descriptor || null,
      photoPath,
      from
    });
    await refresh();
    return res;
  }, [user, refresh, from]);

  return { openCheck, answer, refresh };
}
