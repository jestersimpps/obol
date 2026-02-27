-- Migration: create obol_journal table
-- Run once in Supabase SQL editor

create table if not exists obol_journal (
  id         uuid primary key default gen_random_uuid(),
  content    text not null,
  created_at timestamptz default now()
);

-- Index for fast recency queries
create index if not exists obol_journal_created_at_idx on obol_journal (created_at desc);