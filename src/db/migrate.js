async function migrate(supabaseConfig) {
  const { url, serviceKey, accessToken } = supabaseConfig;

  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal',
  };

  const sqlStatements = [
    // Enable vector extension
    `CREATE EXTENSION IF NOT EXISTS vector;`,

    // Memory table (vector, high-signal)
    `CREATE TABLE IF NOT EXISTS obol_memory (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      content TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'fact'
        CHECK (category IN ('fact','preference','decision','lesson','person','project','event','conversation','resource','pattern','context','email')),
      tags TEXT[] DEFAULT '{}',
      importance FLOAT DEFAULT 0.5,
      source TEXT,
      embedding VECTOR(384),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      accessed_at TIMESTAMPTZ DEFAULT NOW(),
      access_count INT DEFAULT 0
    );`,

    // Messages table (raw log, every message)
    `CREATE TABLE IF NOT EXISTS obol_messages (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      model TEXT,
      tokens_in INT,
      tokens_out INT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`,

    // Vector similarity search function
    `CREATE OR REPLACE FUNCTION match_obol_memories(
      query_embedding VECTOR(384),
      match_threshold FLOAT,
      match_count INT,
      filter_category TEXT DEFAULT NULL
    ) RETURNS TABLE (
      id UUID,
      content TEXT,
      category TEXT,
      tags TEXT[],
      importance FLOAT,
      source TEXT,
      created_at TIMESTAMPTZ,
      accessed_at TIMESTAMPTZ,
      access_count INT,
      similarity FLOAT
    ) LANGUAGE plpgsql AS $$
    BEGIN
      RETURN QUERY
      SELECT
        m.id, m.content, m.category, m.tags, m.importance, m.source,
        m.created_at, m.accessed_at, m.access_count,
        1 - (m.embedding <=> query_embedding) AS similarity
      FROM obol_memory m
      WHERE 1 - (m.embedding <=> query_embedding) > match_threshold
        AND (filter_category IS NULL OR m.category = filter_category)
      ORDER BY m.embedding <=> query_embedding
      LIMIT match_count;
    END;
    $$;`,

    // Indexes
    `CREATE INDEX IF NOT EXISTS obol_memory_embedding_idx ON obol_memory
      USING hnsw (embedding vector_cosine_ops);`,
    `CREATE INDEX IF NOT EXISTS obol_memory_created_at_idx ON obol_memory (created_at);`,
    `CREATE INDEX IF NOT EXISTS obol_memory_category_idx ON obol_memory (category);`,
    `CREATE INDEX IF NOT EXISTS obol_messages_chat_id_idx ON obol_messages (chat_id, created_at DESC);`,
    `CREATE INDEX IF NOT EXISTS obol_messages_created_at_idx ON obol_messages (created_at DESC);`,

    // User isolation columns
    `ALTER TABLE obol_memory ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 0;`,
    `ALTER TABLE obol_messages ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 0;`,
    `CREATE INDEX IF NOT EXISTS idx_obol_memory_user ON obol_memory (user_id);`,
    `CREATE INDEX IF NOT EXISTS idx_obol_messages_user ON obol_messages (user_id);`,

    // Update match function to support user_id filtering
    `CREATE OR REPLACE FUNCTION match_obol_memories(
      query_embedding VECTOR(384),
      match_threshold FLOAT,
      match_count INT,
      filter_category TEXT DEFAULT NULL,
      filter_user_id BIGINT DEFAULT NULL
    ) RETURNS TABLE (
      id UUID,
      content TEXT,
      category TEXT,
      tags TEXT[],
      importance FLOAT,
      source TEXT,
      created_at TIMESTAMPTZ,
      accessed_at TIMESTAMPTZ,
      access_count INT,
      similarity FLOAT
    ) LANGUAGE plpgsql AS $$
    BEGIN
      RETURN QUERY
      SELECT
        m.id, m.content, m.category, m.tags, m.importance, m.source,
        m.created_at, m.accessed_at, m.access_count,
        1 - (m.embedding <=> query_embedding) AS similarity
      FROM obol_memory m
      WHERE 1 - (m.embedding <=> query_embedding) > match_threshold
        AND (filter_category IS NULL OR m.category = filter_category)
        AND (filter_user_id IS NULL OR m.user_id = filter_user_id)
      ORDER BY m.embedding <=> query_embedding
      LIMIT match_count;
    END;
    $$;`,

    // RLS
    `ALTER TABLE obol_memory ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE obol_messages ENABLE ROW LEVEL SECURITY;`,
    `DO $$ BEGIN
      CREATE POLICY "service_role_all" ON obol_memory FOR ALL TO service_role USING (true) WITH CHECK (true);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;`,
    `DO $$ BEGIN
      CREATE POLICY "service_role_all" ON obol_messages FOR ALL TO service_role USING (true) WITH CHECK (true);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;`,

    // Events table (scheduling & reminders)
    `CREATE TABLE IF NOT EXISTS obol_events (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      user_id BIGINT NOT NULL,
      chat_id BIGINT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      due_at TIMESTAMPTZ NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','cancelled')),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_obol_events_due ON obol_events (due_at) WHERE status = 'pending';`,
    `CREATE INDEX IF NOT EXISTS idx_obol_events_user ON obol_events (user_id);`,
    `ALTER TABLE obol_events ENABLE ROW LEVEL SECURITY;`,
    `DO $$ BEGIN
      CREATE POLICY "service_role_all" ON obol_events FOR ALL TO service_role USING (true) WITH CHECK (true);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;`,

    // Drop redundant user_id from obol_messages (chat_id == user_id for Telegram private chats)
    `DROP INDEX IF EXISTS idx_obol_messages_user;`,
    `ALTER TABLE obol_messages DROP COLUMN IF EXISTS user_id;`,

    // Atomic access count increment for memory search hits
    `CREATE OR REPLACE FUNCTION increment_memory_access(memory_ids UUID[])
    RETURNS VOID LANGUAGE SQL AS $$
      UPDATE obol_memory
      SET access_count = access_count + 1, accessed_at = NOW()
      WHERE id = ANY(memory_ids);
    $$;`,

    // Tool preferences table (per-user toggle + config for optional tools)
    `CREATE TABLE IF NOT EXISTS obol_tool_prefs (
      user_id BIGINT NOT NULL,
      tool_name TEXT NOT NULL,
      enabled BOOLEAN DEFAULT false,
      config JSONB DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, tool_name)
    );`,
    `CREATE INDEX IF NOT EXISTS idx_tool_prefs_user ON obol_tool_prefs (user_id);`,
    `ALTER TABLE obol_tool_prefs ENABLE ROW LEVEL SECURITY;`,
    `DO $$ BEGIN
      CREATE POLICY "service_role_all" ON obol_tool_prefs FOR ALL TO service_role USING (true) WITH CHECK (true);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;`,

    // Cron/recurring event columns
    `ALTER TABLE obol_events ADD COLUMN IF NOT EXISTS cron_expr TEXT;`,
    `ALTER TABLE obol_events ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ;`,
    `ALTER TABLE obol_events ADD COLUMN IF NOT EXISTS run_count INT NOT NULL DEFAULT 0;`,
    `ALTER TABLE obol_events ADD COLUMN IF NOT EXISTS max_runs INT;`,
    `ALTER TABLE obol_events ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ;`,

    `DO $$ BEGIN
      ALTER TABLE obol_events DROP CONSTRAINT IF EXISTS obol_events_status_check;
      ALTER TABLE obol_events ADD CONSTRAINT obol_events_status_check
        CHECK (status IN ('pending','sent','cancelled','completed'));
    EXCEPTION WHEN undefined_object THEN NULL;
    END $$;`,

    // Cleanup: remove message embeddings (replaced by per-turn fact extraction to obol_memory)
    `DROP FUNCTION IF EXISTS match_obol_messages(VECTOR(384), FLOAT, INT, BIGINT);`,
    `DROP INDEX IF EXISTS obol_messages_embedding_idx;`,
    `ALTER TABLE obol_messages DROP COLUMN IF EXISTS embedding;`,

    // Instructions column for agentic cron jobs
    `ALTER TABLE obol_events ADD COLUMN IF NOT EXISTS instructions TEXT;`,

    // User behavior patterns (dedicated table — timing, mood, humor, engagement, communication, topics)
    `CREATE TABLE IF NOT EXISTS obol_user_patterns (
      user_id           BIGINT NOT NULL,
      key               TEXT NOT NULL,
      dimension         TEXT NOT NULL CHECK (dimension IN ('timing','mood','humor','engagement','communication','topics')),
      summary           TEXT NOT NULL,
      data              JSONB DEFAULT '{}',
      confidence        FLOAT DEFAULT 0.5,
      observation_count INT DEFAULT 0,
      first_observed_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, key)
    );`,
    `CREATE INDEX IF NOT EXISTS idx_obol_user_patterns_user ON obol_user_patterns (user_id);`,
    `CREATE INDEX IF NOT EXISTS idx_obol_user_patterns_dimension ON obol_user_patterns (user_id, dimension);`,
    `ALTER TABLE obol_user_patterns ENABLE ROW LEVEL SECURITY;`,
    `DO $$ BEGIN
      CREATE POLICY "service_role_all" ON obol_user_patterns FOR ALL TO service_role USING (true) WITH CHECK (true);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;`,

    // Obol self-memory (separate from user memories — Obol's own brain: research, interests, reflections, patterns)
    `CREATE TABLE IF NOT EXISTS obol_self_memory (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      user_id BIGINT NOT NULL,
      content TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'research'
        CHECK (category IN ('research','interest','self','pattern')),
      tags TEXT[] DEFAULT '{}',
      importance FLOAT DEFAULT 0.5,
      source TEXT,
      embedding VECTOR(384),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      accessed_at TIMESTAMPTZ DEFAULT NOW(),
      access_count INT DEFAULT 0
    );`,
    `CREATE INDEX IF NOT EXISTS idx_obol_self_memory_user ON obol_self_memory (user_id);`,
    `CREATE INDEX IF NOT EXISTS idx_obol_self_memory_category ON obol_self_memory (user_id, category);`,
    `CREATE INDEX IF NOT EXISTS idx_obol_self_memory_embedding ON obol_self_memory USING hnsw (embedding vector_cosine_ops);`,
    `CREATE INDEX IF NOT EXISTS idx_obol_self_memory_created_at ON obol_self_memory (created_at);`,
    `ALTER TABLE obol_self_memory ENABLE ROW LEVEL SECURITY;`,
    `DO $$ BEGIN
      CREATE POLICY "service_role_all" ON obol_self_memory FOR ALL TO service_role USING (true) WITH CHECK (true);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;`,

    `CREATE OR REPLACE FUNCTION match_obol_self_memories(
      query_embedding VECTOR(384),
      match_threshold FLOAT,
      match_count INT,
      filter_category TEXT DEFAULT NULL,
      filter_user_id BIGINT DEFAULT NULL
    ) RETURNS TABLE (
      id UUID,
      content TEXT,
      category TEXT,
      tags TEXT[],
      importance FLOAT,
      source TEXT,
      created_at TIMESTAMPTZ,
      accessed_at TIMESTAMPTZ,
      access_count INT,
      similarity FLOAT
    ) LANGUAGE plpgsql AS $$
    BEGIN
      RETURN QUERY
      SELECT
        m.id, m.content, m.category, m.tags, m.importance, m.source,
        m.created_at, m.accessed_at, m.access_count,
        1 - (m.embedding <=> query_embedding) AS similarity
      FROM obol_self_memory m
      WHERE 1 - (m.embedding <=> query_embedding) > match_threshold
        AND (filter_category IS NULL OR m.category = filter_category)
        AND (filter_user_id IS NULL OR m.user_id = filter_user_id)
      ORDER BY m.embedding <=> query_embedding
      LIMIT match_count;
    END;
    $$;`,

    `CREATE OR REPLACE FUNCTION increment_self_memory_access(memory_ids UUID[])
    RETURNS VOID LANGUAGE SQL AS $$
      UPDATE obol_self_memory
      SET access_count = access_count + 1, accessed_at = NOW()
      WHERE id = ANY(memory_ids);
    $$;`,

    // Event retry tracking
    `ALTER TABLE obol_events ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;`,
    `ALTER TABLE obol_events ADD COLUMN IF NOT EXISTS last_error TEXT;`,

    `DO $$ BEGIN
      ALTER TABLE obol_events DROP CONSTRAINT IF EXISTS obol_events_status_check;
      ALTER TABLE obol_events ADD CONSTRAINT obol_events_status_check
        CHECK (status IN ('pending','sent','cancelled','completed','failed'));
    EXCEPTION WHEN undefined_object THEN NULL;
    END $$;`,

    // Soul backup table (one row per file key: 'soul', 'agents')
    `CREATE TABLE IF NOT EXISTS obol_soul (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`,
    `ALTER TABLE obol_soul ENABLE ROW LEVEL SECURITY;`,
    `DO $$ BEGIN
      CREATE POLICY "service_role_all" ON obol_soul FOR ALL TO service_role USING (true) WITH CHECK (true);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;`,
  ];

  // Save SQL file for manual fallback
  const fs = require('fs');
  const path = require('path');
  const { OBOL_DIR } = require('../config');
  const sqlFile = path.join(OBOL_DIR, 'migrations', 'init.sql');
  fs.mkdirSync(path.dirname(sqlFile), { recursive: true });
  fs.writeFileSync(sqlFile, sqlStatements.join('\n\n'));

  if (!accessToken) {
    console.log(`\n  ⚠️  No access token — cannot run migrations automatically.`);
    console.log(`  Run this SQL in your Supabase dashboard (SQL Editor):`);
    console.log(`  File saved to: ${sqlFile}\n`);
    return;
  }

  const projectRef = url.replace('https://', '').replace('.supabase.co', '');
  const batchedSql = sqlStatements.join('\n\n');

  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: batchedSql }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const err = await res.text();
      console.log(`  ⚠️  Migration warning: ${err.substring(0, 200)}`);
    }
  } catch (e) {
    console.log(`  ⚠️  Migration failed: ${e.message}`);
  }
}

module.exports = { migrate };
