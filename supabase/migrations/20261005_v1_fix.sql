-- TM Messenger v1 hardening + login fix + DM foundation
-- Safe to run on the existing project after the original schema and push_subscriptions exist.

create extension if not exists pgcrypto;

alter table public.profiles add column if not exists public_key text;
alter table public.conversations add column if not exists dm_key text;
create unique index if not exists conversations_dm_key_uidx
  on public.conversations(dm_key)
  where dm_key is not null;

create or replace function public.is_chat_member(p_chat_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.conversation_members
    where chat_id = p_chat_id and user_id = p_user_id
  );
$$;

revoke all on function public.is_chat_member(uuid, uuid) from public;
grant execute on function public.is_chat_member(uuid, uuid) to authenticated;

drop policy if exists "members read membership" on public.conversation_members;
drop policy if exists "members can read membership" on public.conversation_members;
drop policy if exists "members can read conversations" on public.conversations;
drop policy if exists "members read conversations" on public.conversations;
drop policy if exists "members read messages" on public.messages;
drop policy if exists "members send messages" on public.messages;
drop policy if exists "self join" on public.conversation_members;

create policy "members read membership"
on public.conversation_members
for select to authenticated
using (
  user_id = auth.uid() or public.is_chat_member(chat_id, auth.uid())
);

create policy "members can read conversations"
on public.conversations
for select to authenticated
using (public.is_chat_member(id, auth.uid()));

create policy "members read messages"
on public.messages
for select to authenticated
using (public.is_chat_member(chat_id, auth.uid()));

create policy "members send messages"
on public.messages
for insert to authenticated
with check (
  sender_id = auth.uid()
  and public.is_chat_member(chat_id, auth.uid())
);

-- No direct membership inserts: use the controlled RPCs below.
create policy "self push subscriptions"
on public.push_subscriptions
for all to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

create or replace function public.join_main_group()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_chat uuid := '00000000-0000-0000-0000-000000000001';
  v_name text;
  v_inserted boolean := false;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  select display_name into v_name from public.profiles where id = v_uid;
  if v_name is null then raise exception 'profile missing'; end if;

  insert into public.conversation_members(chat_id,user_id)
  values(v_chat,v_uid)
  on conflict do nothing;
  get diagnostics v_inserted = ROW_COUNT;

  if v_inserted then
    insert into public.messages(chat_id,sender_id,ciphertext,message_type)
    values(v_chat,null,jsonb_build_object('systemText', v_name || ' به گروه پیوست')::text,'system');
  end if;

  return v_chat;
end;
$$;

revoke all on function public.join_main_group() from public;
grant execute on function public.join_main_group() to authenticated;

create or replace function public.get_or_create_dm(other_user_id uuid)
returns table(chat_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  key text;
  cid uuid;
begin
  if me is null then raise exception 'not authenticated'; end if;
  if other_user_id is null or other_user_id = me then raise exception 'invalid target'; end if;
  if not exists(select 1 from public.profiles where id=other_user_id) then raise exception 'user not found'; end if;

  key := least(me::text, other_user_id::text) || ':' || greatest(me::text, other_user_id::text);

  select id into cid from public.conversations where dm_key = key limit 1;
  if cid is null then
    insert into public.conversations(type,title,dm_key)
    values('dm',null,key)
    returning id into cid;
  end if;

  insert into public.conversation_members(chat_id,user_id) values(cid,me) on conflict do nothing;
  insert into public.conversation_members(chat_id,user_id) values(cid,other_user_id) on conflict do nothing;

  return query select cid;
end;
$$;

revoke all on function public.get_or_create_dm(uuid) from public;
grant execute on function public.get_or_create_dm(uuid) to authenticated;

create or replace function public.get_my_chats()
returns table(
  chat_id uuid,
  type text,
  title text,
  other_user_id uuid,
  other_name text,
  other_bio text,
  last_message_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with my_memberships as (
    select cm.chat_id
    from public.conversation_members cm
    where cm.user_id = auth.uid()
  ),
  last_messages as (
    select m.chat_id, max(m.created_at) as last_message_at
    from public.messages m
    group by m.chat_id
  )
  select
    c.id,
    c.type,
    c.title,
    case when c.type='dm' then other_m.user_id else null end,
    case when c.type='dm' then p.display_name else null end,
    case when c.type='dm' then p.bio else null end,
    coalesce(lm.last_message_at, c.created_at)
  from public.conversations c
  join my_memberships mine on mine.chat_id = c.id
  left join public.conversation_members other_m
    on other_m.chat_id = c.id
   and other_m.user_id <> auth.uid()
  left join public.profiles p on p.id = other_m.user_id
  left join last_messages lm on lm.chat_id = c.id
  order by coalesce(lm.last_message_at, c.created_at) desc;
$$;

revoke all on function public.get_my_chats() from public;
grant execute on function public.get_my_chats() to authenticated;

-- Realtime publication is already used by the app; add is idempotent on a fresh project.
do $$
begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null;
end $$;
