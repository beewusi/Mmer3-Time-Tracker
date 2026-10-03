// supabase/functions/sign-in/index.ts
//
// Email + password sign-in with a lockout: 5 wrong passwords in a row locks
// that email for 15 minutes. Login.js calls this instead of signing in
// directly, then uses the session it returns.
//
// Every attempt is saved in sign_in_attempts (kept 30 days, reminder-sweep
// deletes older ones). Only wrong passwords count. Downside: someone typing
// wrong passwords for a colleague's email locks the colleague out for 15
// minutes; it shows in sign_in_attempts if it keeps happening.
//
// Note to self: on the free plan Supabase can't block password sign-ins
// itself (that needs the paid "password verification" hook), so someone
// calling the Supabase sign-in address directly skips this. The app always
// goes through here.
//
// Deploy: supabase functions deploy sign-in
// Needs supabase/clock_in_checks.sql.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { email: rawEmail, password } = await req.json().catch(() => ({}));
    const email = String(rawEmail || '').trim().toLowerCase();
    if (!email || !password) return json({ error: 'Enter your email and password.' }, 400);

    const url = Deno.env.get('SUPABASE_URL') ?? '';
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

    // failures since the last success, within the lock window
    const since = new Date(Date.now() - LOCK_MINUTES * 60000).toISOString();
    const { data: recent } = await db
      .from('sign_in_attempts').select('success, created_at')
      .eq('email', email).gte('created_at', since)
      .order('created_at', { ascending: false }).limit(MAX_FAILURES);
    const failures: string[] = [];
    for (const a of recent ?? []) {
      if (a.success) break;
      failures.push(a.created_at);
    }
    if (failures.length >= MAX_FAILURES) {
      // locked until 15 min after the 5th wrong password
      const unlockAt = new Date(new Date(failures[0]).getTime() + LOCK_MINUTES * 60000);
      const minutes = Math.max(1, Math.ceil((unlockAt.getTime() - Date.now()) / 60000));
      return json({
        error: `Too many wrong passwords. This account is locked for ${minutes} more minute${minutes === 1 ? '' : 's'}.`,
        locked: true,
        unlockAt: unlockAt.toISOString()
      }, 429);
    }

    const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      // only a wrong password counts towards the lockout
      const wrongPassword = res.status === 400 && /invalid/i.test(body.error_description || body.msg || body.error || '');
      if (wrongPassword) {
        await db.from('sign_in_attempts').insert({ email, success: false });
        const left = MAX_FAILURES - failures.length - 1;
        return json({
          error: left <= 0
            ? `Incorrect email or password. This account is now locked for ${LOCK_MINUTES} minutes.`
            : left <= 2
              ? `Incorrect email or password. ${left} ${left === 1 ? 'try' : 'tries'} left before the account is locked for ${LOCK_MINUTES} minutes.`
              : 'Incorrect email or password. Please try again.',
          locked: left <= 0
        }, 400);
      }
      if (/confirm/i.test(body.error_description || body.msg || '')) {
        return json({ error: 'Please confirm your email first. Check your inbox for the link.' }, 400);
      }
      return json({ error: 'Sign-in isn’t working right now. Please try again in a minute.' }, 502);
    }

    await db.from('sign_in_attempts').insert({ email, success: true });
    return json({ access_token: body.access_token, refresh_token: body.refresh_token });
  } catch (e) {
    console.error(e);
    return json({ error: 'Sign-in isn’t working right now. Please try again in a minute.' }, 500);
  }
});
