-- Clock-in checks: registered laptops, face, presence checks, screenshots,
-- office networks, flags for the admin and a change log.
-- Safe to run twice.

create extension if not exists pgcrypto;

-- ---------- sessions ----------
-- every clock-in gets its own session id, so evidence, flags, presence checks
-- and screenshots all hang off the same session (records get it at clock-out)
alter table public.employee_status add column if not exists session_id uuid;
alter table public.records add column if not exists session_id uuid;
alter table public.records add column if not exists edit_reason text;

create or replace function public.assign_session_id()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  was_live boolean := false;
  is_live boolean := new.status in ('clocked_in', 'on_break');
begin
  -- upsert on an existing row: the update part handles it
  if tg_op = 'INSERT'
     and exists (select 1 from employee_status where user_id = new.user_id) then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    was_live := old.status in ('clocked_in', 'on_break');
  end if;

  if is_live and not was_live then
    new.session_id := gen_random_uuid();
  elsif tg_op = 'UPDATE' then
    -- never taken from the browser
    new.session_id := old.session_id;
  else
    new.session_id := null;
  end if;
  return new;
end;
$$;

drop trigger if exists assign_session_id on public.employee_status;
create trigger assign_session_id
  before insert or update on public.employee_status
  for each row execute function public.assign_session_id();

-- record saved at clock-out takes the session it came from
create or replace function public.set_record_session()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.session_id is null then
    select session_id into new.session_id
    from employee_status where user_id::text = new.user_id::text;
  end if;
  return new;
end;
$$;

revoke execute on function public.set_record_session() from public, anon, authenticated;

drop trigger if exists set_record_session on public.records;
create trigger set_record_session
  before insert on public.records
  for each row execute function public.set_record_session();

-- ---------- settings ----------
create table if not exists public.security_settings (
  id int primary key default 1 check (id = 1),
  require_registered_device boolean not null default true,
  face_check_enabled boolean not null default true,
  presence_checks_per_session int not null default 4,
  presence_window_minutes int not null default 5,
  screenshots_per_hour int not null default 3,
  network_outage_on date,              -- "office network down today"
  office_wifi_names text[] not null default '{}',  -- checked by the desktop app
  updated_at timestamptz not null default now()
);
insert into public.security_settings (id) values (1) on conflict (id) do nothing;
alter table public.security_settings add column if not exists office_wifi_names text[] not null default '{}';

alter table public.security_settings enable row level security;
drop policy if exists "security_settings_read" on public.security_settings;
create policy "security_settings_read" on public.security_settings
  for select to authenticated using (true);
drop policy if exists "security_settings_admin_update" on public.security_settings;
create policy "security_settings_admin_update" on public.security_settings
  for update to authenticated
  using ((auth.jwt() ->> 'email') = 'admin@mmer3.com')
  with check ((auth.jwt() ->> 'email') = 'admin@mmer3.com');

-- ---------- office networks ----------
-- public internet address of the office connection, added by the admin from
-- the office ("add the network I'm on now")
create table if not exists public.office_networks (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  ip text not null unique,
  created_at timestamptz not null default now()
);

alter table public.office_networks enable row level security;
drop policy if exists "office_networks_admin_all" on public.office_networks;
create policy "office_networks_admin_all" on public.office_networks
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'admin@mmer3.com')
  with check ((auth.jwt() ->> 'email') = 'admin@mmer3.com');

-- ---------- registered laptops (passkeys) ----------
-- written by the device-auth function only
create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  label text,
  credential_id text not null unique,
  public_key text not null,
  counter bigint not null default 0,
  transports text[],
  device_key text,                     -- random id kept in that browser
  synced boolean not null default false, -- passkey copied to a phone/other device by iCloud or Google
  status text not null default 'pending' check (status in ('pending', 'approved', 'revoked')),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  last_used_at timestamptz
);
create index if not exists devices_user_idx on public.devices (user_id);
alter table public.devices add column if not exists synced boolean not null default false;

alter table public.devices enable row level security;
drop policy if exists "devices_select_own" on public.devices;
create policy "devices_select_own" on public.devices
  for select to authenticated using (auth.uid() = user_id);
-- laptops are removed by the admin only (one laptop each; 6 Oct)
drop policy if exists "devices_delete_own" on public.devices;
drop policy if exists "devices_admin_all" on public.devices;
create policy "devices_admin_all" on public.devices
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'admin@mmer3.com')
  with check ((auth.jwt() ->> 'email') = 'admin@mmer3.com');

-- one-time challenges for passkey sign-ups/checks, function only
create table if not exists public.webauthn_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  challenge text not null,
  purpose text not null check (purpose in ('register', 'verify')),
  created_at timestamptz not null default now()
);
alter table public.webauthn_challenges enable row level security;

-- ---------- face ----------
-- face kept as 128 numbers (descriptor) plus the photo it came from.
-- employees can't read, write or delete the table directly: saving and
-- withdrawing go through the two functions below, and the match is worked
-- out in clock-check, so nobody can copy or swap face numbers.
-- Withdrawn = numbers and photo wiped, row kept so a withdrawal still shows.
create table if not exists public.face_profiles (
  user_id uuid primary key,
  descriptor float8[] not null,
  photo_path text,
  consent_at timestamptz not null,
  consent_version text not null default '2026-10-03',
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz
);
alter table public.face_profiles drop constraint if exists face_profiles_status_check;
alter table public.face_profiles add constraint face_profiles_status_check
  check (status in ('pending', 'approved', 'rejected', 'withdrawn'));

alter table public.face_profiles enable row level security;
drop policy if exists "face_select_own" on public.face_profiles;
drop policy if exists "face_insert_own" on public.face_profiles;
drop policy if exists "face_update_own" on public.face_profiles;
drop policy if exists "face_delete_own" on public.face_profiles;
drop policy if exists "face_admin_all" on public.face_profiles;
create policy "face_admin_all" on public.face_profiles
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'admin@mmer3.com')
  with check ((auth.jwt() ->> 'email') = 'admin@mmer3.com');

-- the browser can't set the status itself; save_face_profile approves it
-- once its checks pass (mmer3.face_save is set inside that function only)
create or replace function public.protect_face_profile()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(auth.jwt() ->> 'email', '') = 'admin@mmer3.com'
     or coalesce(auth.jwt() ->> 'role', '') = 'service_role'
     or auth.uid() is null then
    new.updated_at := now();
    return new;
  end if;
  -- withdrawing: only with the numbers and photo gone
  if new.status = 'withdrawn' and new.descriptor = '{}' and new.photo_path is null then
    new.approved_at := null;
    new.updated_at := now();
    return new;
  end if;
  if current_setting('mmer3.face_save', true) = 'on' then
    new.updated_at := now();
    return new;
  end if;
  new.status := 'pending';
  new.approved_at := null;
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.created_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists protect_face_profile on public.face_profiles;
create trigger protect_face_profile
  before insert or update on public.face_profiles
  for each row execute function public.protect_face_profile();

-- own face status without the numbers
create or replace function public.my_face_profile()
returns table (status text, photo_path text, consent_at timestamptz, consent_version text, updated_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select status, photo_path, consent_at, consent_version, updated_at
  from face_profiles where user_id = auth.uid();
$$;

revoke execute on function public.my_face_profile() from public, anon;
grant execute on function public.my_face_profile() to authenticated;

-- same face already registered to someone else? returns their name
create or replace function public.face_registered_to_other(probe float8[])
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  match_name text;
begin
  if auth.uid() is null or array_length(probe, 1) is distinct from 128 then
    return null;
  end if;

  select coalesce(p.full_name, p.email) into match_name
  from face_profiles f
  left join profiles p on p.id = f.user_id
  where f.user_id <> auth.uid()
    and f.status in ('pending', 'approved')
    and array_length(f.descriptor, 1) = 128
    and sqrt((
      select sum((a.v - b.v) ^ 2)
      from unnest(f.descriptor) with ordinality a(v, i)
      join unnest(probe) with ordinality b(v, i) using (i)
    )) < 0.45
  limit 1;

  return match_name;
end;
$$;

revoke execute on function public.face_registered_to_other(float8[]) from public, anon;
grant execute on function public.face_registered_to_other(float8[]) to authenticated;

-- save (or retake) my face: checked here, not just in the browser
-- (one face, straight on, light are checked by the camera step). Approved
-- straight away if it isn't someone else's face. Retake only after the admin
-- resets it, or after withdrawing.
create or replace function public.save_face_profile(probe float8[], photo text, version text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  other text;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if array_length(probe, 1) is distinct from 128 then
    raise exception 'Face data is not valid';
  end if;
  if photo is null or photo not like auth.uid()::text || '/face-%' then
    raise exception 'Photo is not valid';
  end if;
  -- approved = locked; the admin rejects it to allow a retake
  if exists (select 1 from face_profiles where user_id = auth.uid() and status = 'approved') then
    raise exception 'FACE_LOCKED';
  end if;
  other := public.face_registered_to_other(probe);
  if other is not null then
    raise exception 'FACE_TAKEN:%', other;
  end if;

  perform set_config('mmer3.face_save', 'on', true);
  insert into face_profiles (user_id, descriptor, photo_path, consent_at, consent_version, status, approved_at)
  values (auth.uid(), probe, photo, now(), coalesce(version, '2026-10-03'), 'approved', now())
  on conflict (user_id) do update
    set descriptor = excluded.descriptor,
        photo_path = excluded.photo_path,
        consent_at = excluded.consent_at,
        consent_version = excluded.consent_version,
        status = 'approved',
        approved_at = now();
  perform set_config('mmer3.face_save', 'off', true);
end;
$$;

revoke execute on function public.save_face_profile(float8[], text, text) from public, anon;
grant execute on function public.save_face_profile(float8[], text, text) to authenticated;

-- withdraw consent: numbers and photo wiped, returns the photo to delete
create or replace function public.withdraw_face_consent()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  old_photo text;
begin
  select photo_path into old_photo from face_profiles where user_id = auth.uid();
  update face_profiles
     set descriptor = '{}', photo_path = null, status = 'withdrawn'
   where user_id = auth.uid();
  return old_photo;
end;
$$;

revoke execute on function public.withdraw_face_consent() from public, anon;
grant execute on function public.withdraw_face_consent() to authenticated;

-- ---------- what was checked at each clock-in ----------
-- written by the clock-check function only
create table if not exists public.clock_evidence (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  session_id uuid,
  kind text not null default 'clock_in' check (kind in ('clock_in', 'clock_out')),
  created_at timestamptz not null default now(),
  device_id uuid,
  device_verified boolean not null default false,
  device_key text,
  ip text,
  network_id uuid,
  on_office_network boolean,
  location_status text,
  face_result text check (face_result in ('match', 'no_match', 'no_face', 'not_registered', 'skipped')),
  face_distance real,
  face_attempts int,
  blink_passed boolean,
  photo_path text,
  user_agent text,
  wifi_name text
);
alter table public.clock_evidence add column if not exists wifi_name text;
create index if not exists clock_evidence_session_idx on public.clock_evidence (session_id);
-- one clock-in record per session, even if the check is sent twice at once
create unique index if not exists clock_evidence_session_kind_key on public.clock_evidence (session_id, kind);
create index if not exists clock_evidence_device_key_idx on public.clock_evidence (device_key, created_at);

alter table public.clock_evidence enable row level security;
drop policy if exists "clock_evidence_select_own" on public.clock_evidence;
create policy "clock_evidence_select_own" on public.clock_evidence
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "clock_evidence_admin_all" on public.clock_evidence;
create policy "clock_evidence_admin_all" on public.clock_evidence
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'admin@mmer3.com')
  with check ((auth.jwt() ->> 'email') = 'admin@mmer3.com');

-- ---------- flags for the admin's Review page ----------
create table if not exists public.session_flags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  session_id uuid,
  type text not null check (type in (
    'device_unregistered', 'device_not_verified', 'face_failed', 'face_not_registered',
    'off_network', 'same_device', 'presence_missed', 'presence_failed',
    'away', 'contact_gap', 'unauthorised_location', 'offline_clock_in', 'no_checks', 'device_pending'
  )),
  severity text not null default 'medium' check (severity in ('low', 'medium', 'high')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  status text not null default 'open',
  decided_at timestamptz,
  admin_note text
);
alter table public.session_flags drop constraint if exists session_flags_type_check;
alter table public.session_flags add constraint session_flags_type_check check (type in (
  'device_unregistered', 'device_not_verified', 'face_failed', 'face_not_registered',
  'off_network', 'same_device', 'presence_missed', 'presence_failed',
  'away', 'contact_gap', 'unauthorised_location', 'offline_clock_in', 'no_checks', 'device_pending'
));
create index if not exists session_flags_session_idx on public.session_flags (session_id);
create index if not exists session_flags_open_idx on public.session_flags (status, created_at);

alter table public.session_flags enable row level security;
drop policy if exists "flags_select_own" on public.session_flags;
create policy "flags_select_own" on public.session_flags
  for select to authenticated using (auth.uid() = user_id);
-- the app can only add flags against yourself (away time), never decide them
drop policy if exists "flags_insert_own" on public.session_flags;
create policy "flags_insert_own" on public.session_flags
  for insert to authenticated
  with check (auth.uid() = user_id and status in ('open', 'noted') and decided_at is null and type in ('away'));
drop policy if exists "flags_admin_all" on public.session_flags;
create policy "flags_admin_all" on public.session_flags
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'admin@mmer3.com')
  with check ((auth.jwt() ->> 'email') = 'admin@mmer3.com');

-- ---------- presence checks ----------
-- scheduled at clock-in by clock-check, answered from the web app or the
-- desktop app through clock-check (face matched there), marked missed by
-- reminder-sweep. Employees only see their own, and only once they're due
-- (so nobody can see when the next one is coming).
create table if not exists public.presence_checks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  session_id uuid not null,
  due_at timestamptz not null,
  expires_at timestamptz not null,
  responded_at timestamptz,
  result text not null default 'pending' check (result in ('pending', 'passed', 'failed', 'missed')),
  face_distance real,
  photo_path text,
  answered_from text check (answered_from in ('web', 'desktop'))
);
create index if not exists presence_checks_user_idx on public.presence_checks (user_id, result, due_at);

alter table public.presence_checks enable row level security;
drop policy if exists "presence_select_own" on public.presence_checks;
create policy "presence_select_own" on public.presence_checks
  for select to authenticated using (auth.uid() = user_id and due_at <= now());
drop policy if exists "presence_update_own" on public.presence_checks;
drop policy if exists "presence_admin_all" on public.presence_checks;
create policy "presence_admin_all" on public.presence_checks
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'admin@mmer3.com')
  with check ((auth.jwt() ->> 'email') = 'admin@mmer3.com');

-- answering: only once, only inside the window, times set here
create or replace function public.protect_presence_check()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(auth.jwt() ->> 'email', '') = 'admin@mmer3.com'
     or coalesce(auth.jwt() ->> 'role', '') = 'service_role'
     or auth.uid() is null then
    return new;
  end if;

  if old.result <> 'pending' or now() < old.due_at or now() > old.expires_at then
    raise exception 'This check is no longer open';
  end if;
  if new.result not in ('passed', 'failed') then
    raise exception 'Invalid result';
  end if;

  new.user_id := old.user_id;
  new.session_id := old.session_id;
  new.due_at := old.due_at;
  new.expires_at := old.expires_at;
  new.responded_at := now();
  return new;
end;
$$;

drop trigger if exists protect_presence_check on public.presence_checks;
create trigger protect_presence_check
  before update on public.presence_checks
  for each row execute function public.protect_presence_check();

-- clock-out: that session's checks still to come are dropped, so they don't
-- pop up in the next session
create or replace function public.drop_checks_after_clock_out()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status in ('clocked_in', 'on_break')
     and new.status not in ('clocked_in', 'on_break')
     and old.session_id is not null then
    delete from presence_checks
     where session_id = old.session_id and result = 'pending' and due_at > now();
  end if;
  return null;
end;
$$;

drop trigger if exists drop_checks_after_clock_out on public.employee_status;
create trigger drop_checks_after_clock_out
  after update on public.employee_status
  for each row execute function public.drop_checks_after_clock_out();

-- tidy up: checks left over from sessions already ended
delete from public.presence_checks p
 where p.result = 'pending' and p.due_at > now()
   and not exists (
     select 1 from public.employee_status s
      where s.session_id = p.session_id and s.status in ('clocked_in', 'on_break'));

-- ---------- heartbeats and away time ----------
-- last time the web app / desktop app checked in; times set here, not by the browser
create table if not exists public.heartbeats (
  user_id uuid primary key,
  source text not null default 'web' check (source in ('web', 'desktop')),
  web_seen_at timestamptz,
  desktop_seen_at timestamptz,
  last_seen_at timestamptz,
  idle_state text,                     -- active / idle / locked
  open_gap_started_at timestamptz,     -- set by reminder-sweep while a gap is open
  wifi_name text                       -- from the desktop app
);
alter table public.heartbeats add column if not exists wifi_name text;

alter table public.heartbeats enable row level security;
-- read, add, update own; no delete (deleting would wipe an open contact gap)
drop policy if exists "heartbeats_own" on public.heartbeats;
drop policy if exists "heartbeats_select_own" on public.heartbeats;
create policy "heartbeats_select_own" on public.heartbeats
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "heartbeats_insert_own" on public.heartbeats;
create policy "heartbeats_insert_own" on public.heartbeats
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "heartbeats_update_own" on public.heartbeats;
create policy "heartbeats_update_own" on public.heartbeats
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "heartbeats_admin_select" on public.heartbeats;
create policy "heartbeats_admin_select" on public.heartbeats
  for select to authenticated using ((auth.jwt() ->> 'email') = 'admin@mmer3.com');

create or replace function public.stamp_heartbeat()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') = 'service_role' then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    new.web_seen_at := old.web_seen_at;
    new.desktop_seen_at := old.desktop_seen_at;
    new.open_gap_started_at := old.open_gap_started_at;
  else
    new.web_seen_at := null;
    new.desktop_seen_at := null;
    new.open_gap_started_at := null;
  end if;
  if new.source = 'desktop' then
    new.desktop_seen_at := now();
  else
    new.web_seen_at := now();
  end if;
  new.last_seen_at := now();
  return new;
end;
$$;

drop trigger if exists stamp_heartbeat on public.heartbeats;
create trigger stamp_heartbeat
  before insert or update on public.heartbeats
  for each row execute function public.stamp_heartbeat();

-- away / locked / contact gap periods within a session
create table if not exists public.activity_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  session_id uuid,
  type text not null check (type in ('idle', 'locked', 'contact_gap')),
  started_at timestamptz not null,
  ended_at timestamptz,
  source text check (source in ('web', 'desktop', 'server')),
  created_at timestamptz not null default now()
);
create index if not exists activity_events_session_idx on public.activity_events (session_id);

alter table public.activity_events enable row level security;
drop policy if exists "activity_select_own" on public.activity_events;
create policy "activity_select_own" on public.activity_events
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "activity_insert_own" on public.activity_events;
create policy "activity_insert_own" on public.activity_events
  for insert to authenticated
  with check (auth.uid() = user_id and type in ('idle', 'locked') and ended_at is not null);
drop policy if exists "activity_admin_all" on public.activity_events;
create policy "activity_admin_all" on public.activity_events
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'admin@mmer3.com')
  with check ((auth.jwt() ->> 'email') = 'admin@mmer3.com');

-- ---------- screenshots ----------
create table if not exists public.screenshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  session_id uuid,
  taken_at timestamptz not null default now(),
  path text not null,
  screen_count int default 1
);
create index if not exists screenshots_session_idx on public.screenshots (session_id, taken_at);

alter table public.screenshots enable row level security;
drop policy if exists "screenshots_select_own" on public.screenshots;
create policy "screenshots_select_own" on public.screenshots
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "screenshots_insert_own" on public.screenshots;
create policy "screenshots_insert_own" on public.screenshots
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "screenshots_admin_all" on public.screenshots;
create policy "screenshots_admin_all" on public.screenshots
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'admin@mmer3.com')
  with check ((auth.jwt() ->> 'email') = 'admin@mmer3.com');

-- ---------- private storage: clock-in / presence photos, faces, screenshots ----------
-- files go in a folder named after the user's id: <user id>/<file>
insert into storage.buckets (id, name, public)
values ('evidence', 'evidence', false), ('screenshots', 'screenshots', false)
on conflict (id) do update set public = false;

drop policy if exists "evidence_insert_own" on storage.objects;
create policy "evidence_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id in ('evidence', 'screenshots')
              and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "evidence_select_own" on storage.objects;
create policy "evidence_select_own" on storage.objects
  for select to authenticated
  using (bucket_id in ('evidence', 'screenshots')
         and ((storage.foldername(name))[1] = auth.uid()::text
              or (auth.jwt() ->> 'email') = 'admin@mmer3.com'));

-- own face setup photo can be removed (withdrawing consent); clock-in photos can't
drop policy if exists "evidence_delete_own_face" on storage.objects;
create policy "evidence_delete_own_face" on storage.objects
  for delete to authenticated
  using (bucket_id = 'evidence'
         and (storage.foldername(name))[1] = auth.uid()::text
         and storage.filename(name) like 'face-%');

drop policy if exists "evidence_admin_delete" on storage.objects;
create policy "evidence_admin_delete" on storage.objects
  for delete to authenticated
  using (bucket_id in ('evidence', 'screenshots')
         and (auth.jwt() ->> 'email') = 'admin@mmer3.com');

-- ---------- change log ----------
-- admin edits to saved sessions keep the before and after, with the reason
create table if not exists public.change_log (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  record_id text,
  action text not null,
  before jsonb,
  after jsonb,
  reason text,
  changed_by uuid,
  changed_by_email text,
  created_at timestamptz not null default now()
);
create index if not exists change_log_created_idx on public.change_log (created_at desc);

alter table public.change_log enable row level security;
drop policy if exists "change_log_admin_select" on public.change_log;
create policy "change_log_admin_select" on public.change_log
  for select to authenticated using ((auth.jwt() ->> 'email') = 'admin@mmer3.com');
-- edits to a session that's still running are logged from the admin page
drop policy if exists "change_log_admin_insert" on public.change_log;
create policy "change_log_admin_insert" on public.change_log
  for insert to authenticated
  with check ((auth.jwt() ->> 'email') = 'admin@mmer3.com' and changed_by = auth.uid());

create or replace function public.log_record_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into change_log (table_name, record_id, action, before, after, reason, changed_by, changed_by_email)
  values (
    tg_table_name,
    coalesce(new.id, old.id)::text,
    lower(tg_op),
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end,
    case when tg_op = 'DELETE' then null else new.edit_reason end,
    auth.uid(),
    auth.jwt() ->> 'email'
  );
  return coalesce(new, old);
end;
$$;

revoke execute on function public.log_record_change() from public, anon, authenticated;

drop trigger if exists log_record_change on public.records;
create trigger log_record_change
  after update or delete on public.records
  for each row
  when (coalesce(auth.jwt() ->> 'email', '') = 'admin@mmer3.com')
  execute function public.log_record_change();

-- ---------- sign-in attempts (lockout) ----------
create table if not exists public.sign_in_attempts (
  id bigserial primary key,
  email text not null,
  success boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists sign_in_attempts_email_idx on public.sign_in_attempts (lower(email), created_at desc);
alter table public.sign_in_attempts enable row level security;

-- ---------- live updates for the admin ----------
do $$
begin
  begin
    alter publication supabase_realtime add table public.session_flags;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.presence_checks;
  exception when duplicate_object then null;
  end;
  -- signed out straight away when the account is removed
  begin
    alter publication supabase_realtime add table public.profiles;
  exception when duplicate_object then null;
  end;
end $$;

-- =====================================================================
-- Fewer approvals, real blocks (4 Oct)
-- Setup is automatic: faces approved when saved, laptops approved when
-- registered on an office network. Clock-ins only start through
-- clock-check, after the face and laptop checks. Only face mismatches wait
-- for the admin; everything else is just recorded.
-- =====================================================================

-- Office network only, or anywhere (just recorded)
alter table public.security_settings add column if not exists network_mode text not null default 'anywhere';
alter table public.security_settings drop constraint if exists security_settings_network_mode_check;
alter table public.security_settings add constraint security_settings_network_mode_check
  check (network_mode in ('anywhere', 'office_only'));

-- laptops: where it was registered from, and how it got approved
alter table public.devices add column if not exists registered_ip text;
alter table public.devices add column if not exists approved_how text;   -- 'office_network' or 'admin'

-- faces still waiting from before: approved now (setup is automatic)
update public.face_profiles set status = 'approved', approved_at = coalesce(approved_at, now())
 where status = 'pending';

-- paused after a missed presence check; only clock-check can resume it
alter table public.employee_status add column if not exists paused_for_check boolean not null default false;
alter table public.breaks add column if not exists reason text;   -- null = normal break, 'missed_check' = paused

-- hours from a laptop still waiting for the admin: held, counted once that
-- laptop is approved. Decided at clock-in from the laptop that passed the
-- check (clock-check sets it on employee_status), copied to the record.
alter table public.employee_status add column if not exists held_for_laptop boolean not null default false;
alter table public.employee_status add column if not exists held_device_id uuid;
alter table public.records add column if not exists held_for_laptop boolean not null default false;
alter table public.records add column if not exists held_device_id uuid;

create or replace function public.hold_record_for_laptop()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  live record;
begin
  select held_for_laptop, held_device_id into live
    from employee_status
   where user_id::text = new.user_id::text and status in ('clocked_in', 'on_break');
  new.held_for_laptop := coalesce(live.held_for_laptop, false);
  new.held_device_id := case when coalesce(live.held_for_laptop, false) then live.held_device_id end;
  return new;
end;
$$;

revoke execute on function public.hold_record_for_laptop() from public, anon, authenticated;

drop trigger if exists hold_record_for_laptop on public.records;
create trigger hold_record_for_laptop
  before insert on public.records
  for each row execute function public.hold_record_for_laptop();

-- that laptop approved: its held hours count now (and a session still
-- running on it stops being held)
create or replace function public.release_held_records()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    update records set held_for_laptop = false
     where held_device_id = new.id and held_for_laptop;
    perform set_config('mmer3.release', 'on', true);
    update employee_status set held_for_laptop = false
     where held_device_id = new.id and held_for_laptop;
    perform set_config('mmer3.release', 'off', true);
  end if;
  return new;
end;
$$;

revoke execute on function public.release_held_records() from public, anon, authenticated;

drop trigger if exists release_held_records on public.devices;
create trigger release_held_records
  after update on public.devices
  for each row execute function public.release_held_records();

-- sessions are saved at clock-out by clock-check (hours worked out there),
-- not by the browser
drop policy if exists "records_insert_own" on public.records;

-- Only face mismatches (and clock-ins sent later from offline, whose time
-- can't be checked) wait for the admin. Everything else is recorded on the
-- session ('noted') with nothing to decide.
alter table public.session_flags drop constraint if exists session_flags_status_check;
alter table public.session_flags add constraint session_flags_status_check
  check (status in ('open', 'noted', 'authorised', 'declined'));

create or replace function public.note_minor_flags()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'open' and new.type not in ('face_failed', 'presence_failed', 'offline_clock_in') then
    new.status := 'noted';
  end if;
  return new;
end;
$$;

drop trigger if exists note_minor_flags on public.session_flags;
create trigger note_minor_flags
  before insert on public.session_flags
  for each row execute function public.note_minor_flags();

update public.session_flags set status = 'noted'
 where status = 'open' and type not in ('face_failed', 'presence_failed', 'offline_clock_in');

-- employee_status: a session only starts through clock-check (face +
-- laptop checked there), and a pause after a missed presence check only
-- ends there (face again). Breaks, resuming a normal break and clocking out
-- stay as they were. Admin, service role and the SQL editor skip this.
-- (Replaces the version in security_hardening.sql.)
create or replace function public.protect_employee_status()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(auth.jwt() ->> 'email', '') = 'admin@mmer3.com'
     or coalesce(auth.jwt() ->> 'role', '') = 'service_role'
     or auth.uid() is null
     or current_setting('mmer3.release', true) = 'on' then   -- laptop approved (release_held_records)
    return new;
  end if;

  -- upsert fires the insert trigger first even when the row exists
  if tg_op = 'INSERT'
     and exists (select 1 from employee_status where user_id = new.user_id) then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.status in ('clocked_in', 'on_break')
     and new.status in ('clocked_in', 'on_break') then
    new.clock_in_at := old.clock_in_at;
    new.location_status := old.location_status;
    new.held_for_laptop := old.held_for_laptop;
    new.held_device_id := old.held_device_id;
    -- a break they start themselves is never a pause
    new.paused_for_check := case when old.status = 'clocked_in' then false else old.paused_for_check end;

    if old.status = 'on_break' and new.status = 'clocked_in' and old.paused_for_check then
      raise exception 'PAUSED_FOR_CHECK';
    end if;

    if old.status = 'clocked_in' and new.status = 'on_break' then
      new.break_started_at := now();
      new.break_accum_seconds := coalesce(old.break_accum_seconds, 0);
    elsif old.status = 'on_break' and new.status = 'clocked_in' then
      new.break_started_at := null;
      new.break_accum_seconds := coalesce(old.break_accum_seconds, 0)
        + greatest(0, round(extract(epoch from (now() - coalesce(old.break_started_at, now())))))::int;
    else
      new.break_started_at := old.break_started_at;
      new.break_accum_seconds := coalesce(old.break_accum_seconds, 0);
    end if;
    return new;
  end if;

  -- a new session from the browser: not allowed, it goes through clock-check
  if new.status in ('clocked_in', 'on_break') then
    raise exception 'CLOCK_IN_NEEDS_CHECKS';
  end if;

  -- clocking out (also from a pause)
  new.paused_for_check := false;
  new.held_for_laptop := false;
  new.held_device_id := null;
  return new;
end;
$$;

drop trigger if exists protect_employee_status on public.employee_status;
create trigger protect_employee_status
  before insert or update on public.employee_status
  for each row execute function public.protect_employee_status();

-- employees see their laptop approved without refreshing
do $$
begin
  begin
    alter publication supabase_realtime add table public.devices;
  exception when duplicate_object then null;
  end;
end $$;

-- ---------- office Wi-Fi routers (4 Oct) ----------
-- The router's own ID (BSSID), read by the desktop app. It stays the same
-- when the office's internet address changes. Not shown to the admin: each
-- router is tied to one office network and learned by itself (clock-ins on
-- that network's address, or when the admin adds the network).
create table if not exists public.office_routers (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  router text not null unique,          -- aa:bb:cc:dd:ee:ff
  created_at timestamptz not null default now()
);
alter table public.office_routers enable row level security;
drop policy if exists "office_routers_admin_all" on public.office_routers;
create policy "office_routers_admin_all" on public.office_routers
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'admin@mmer3.com')
  with check ((auth.jwt() ->> 'email') = 'admin@mmer3.com');

alter table public.heartbeats add column if not exists wifi_router text;
alter table public.clock_evidence add column if not exists wifi_router text;
alter table public.devices add column if not exists registered_router text;

-- routers belong to an office network; removing the network removes them
alter table public.office_routers add column if not exists network_id uuid
  references public.office_networks(id) on delete cascade;
-- routers added by hand before this (no network) aren't used any more
delete from public.office_routers where network_id is null;
