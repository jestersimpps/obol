-- Migration: create obol_journal table
-- Run once in Supabase SQL editor

create table if not exists obol_journal (
  id         uuid primary key default gen_random_uuid(),
  user_id    bigint not null default 0,
  content    text not null,
  created_at timestamptz default now()
);

-- Index for fast per-user recency queries
create index if not exists obol_journal_user_created_at_idx on obol_journal (user_id, created_at desc);
