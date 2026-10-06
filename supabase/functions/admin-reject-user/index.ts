// supabase/functions/admin-reject-user/index.ts
//
// Deletes an account: profiles row and auth.users row. Deleting only the
// profile leaves an auth user behind and that email can't sign up again.
// Records, time off and timesheet approvals are kept (needs
// supabase/keep_employee_history.sql), with the name saved on them first.
// Face data (numbers and set-up photos), laptops and app contact are removed.
//
// Admin only (checked by email, same as ADMIN_EMAIL in src/supabase.js). Uses
// the service role key, which Supabase injects on deploy and never reaches the
// browser.
//
// Deploy: supabase functions deploy admin-reject-user
// (No secrets to set, SUPABASE_URL, SUPABASE_ANON_KEY and
// SUPABASE_SERVICE_ROLE_KEY are provided automatically.)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ADMIN_EMAIL = 'admin@mmer3.com';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' }
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization') ?? '';

    // Check the caller is the admin first. This client uses the caller's own
    // JWT.
    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user: caller }, error: callerError } = await callerClient.auth.getUser();
    if (callerError || !caller || caller.email !== ADMIN_EMAIL) {
      return jsonResponse({ error: 'Not authorized' }, 403);
    }

    const { userId } = await req.json();
    if (!userId) {
      return jsonResponse({ error: 'Missing userId' }, 400);
    }

    // Service role client, only used after the admin check.
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Name saved on their history before the profile goes.
    const { data: profile } = await adminClient
      .from('profiles').select('full_name, email').eq('id', userId).maybeSingle();
    const employeeName = profile?.full_name || profile?.email || null;
    if (employeeName) {
      await adminClient.from('records').update({ employee_name: employeeName }).eq('user_id', userId);
      await adminClient.from('time_off_requests').update({ employee_name: employeeName }).eq('user_id', userId);
    }

    // Face data goes with the account: the numbers and the set-up photos.
    // Clock-in photos stay with their history (screenshots go after 14 days).
    const { data: files } = await adminClient.storage.from('evidence').list(userId, { limit: 100 });
    const facePhotos = (files || []).filter(f => f.name.startsWith('face-')).map(f => `${userId}/${f.name}`);
    if (facePhotos.length) await adminClient.storage.from('evidence').remove(facePhotos);
    await adminClient.from('face_profiles').delete().eq('user_id', userId);
    // laptops and app contact go too, so the laptop can be given to someone else
    await adminClient.from('devices').delete().eq('user_id', userId);
    await adminClient.from('heartbeats').delete().eq('user_id', userId);
    await adminClient.from('webauthn_challenges').delete().eq('user_id', userId);

    // Live state only. History stays.
    await adminClient.from('employee_status').delete().eq('user_id', userId);
    await adminClient.from('push_subscriptions').delete().eq('user_id', userId);
    await adminClient.from('profiles').delete().eq('id', userId);

    const { error: deleteError } = await adminClient.auth.admin.deleteUser(userId);
    if (deleteError) {
      // Foreign key still in place = keep_employee_history.sql hasn't been run.
      if (/foreign key|violates/i.test(deleteError.message)) {
        return jsonResponse({ error: 'Could not delete this account because their records are still linked to it. Run supabase/keep_employee_history.sql first.' }, 400);
      }
      throw deleteError;
    }

    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 400);
  }
});