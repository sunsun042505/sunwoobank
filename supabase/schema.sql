-- SunwooBank Supabase schema (DEMO)
-- Run this in Supabase SQL Editor

create extension if not exists pgcrypto;

-- NOTE:
-- "rrn_hash" is for demo "unique name disambiguation".
-- DO NOT store real 주민등록번호 in any app. Use a fictional 13-digit "식별번호" for demo only.

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  customer_no text unique not null,
  name text not null,
  rrn_hash text unique not null,        -- 식별번호 해시(원문 저장 금지)
  rrn_birth6 text not null,             -- 앞 6자리(생년월일 형태)만 저장(데모)
  phone text,
  email text unique,
  address text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  role text not null default 'customer',
  created_at timestamptz not null default now()
);

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  account_no text unique not null,
  type text not null default '입출금',
  status text not null default '정상',
  balance bigint not null default 0,
  flags jsonb not null default jsonb_build_object(
    'limitAccount', true,
    'paymentStop', false,
    'seizure', false,
    'provisionalSeizure', false
  ),
  holds jsonb not null default '[]'::jsonb,
  account_pin_hash text, -- 계좌 비밀번호(핀) 해시
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  kind text not null, -- 입금/출금/이체출금/이체입금
  amount bigint not null,
  memo text,
  created_at timestamptz not null default now()
);

create table if not exists public.jesingo (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  account_id uuid references public.accounts(id) on delete set null,
  category text not null, -- 비밀번호변경/정보변경/분실신고/기타
  item text,              -- 분실 항목 등
  field text,             -- 정보변경 항목 등
  old_value text,
  new_value text,
  detail text,
  status text not null default '접수',
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

-- OPTIONAL RLS
alter table public.customers enable row level security;
alter table public.profiles enable row level security;
alter table public.accounts enable row level security;
alter table public.transactions enable row level security;
alter table public.jesingo enable row level security;

-- Read-only policies for customer (server functions with service_role bypass RLS anyway)
create policy if not exists "customer_read_own_accounts"
on public.accounts for select
using (
  exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.customer_id = accounts.customer_id
  )
);

create policy if not exists "customer_read_own_transactions"
on public.transactions for select
using (
  exists (
    select 1 from public.accounts a
    join public.profiles p on p.customer_id = a.customer_id
    where p.user_id = auth.uid() and transactions.account_id = a.id
  )
);

create policy if not exists "customer_read_own_profile"
on public.profiles for select
using (user_id = auth.uid());

create policy if not exists "customer_read_own_customer"
on public.customers for select
using (
  exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.customer_id = customers.id)
);
