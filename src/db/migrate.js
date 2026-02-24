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

  for (const sql of sqlStatements) {
    try {
      const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: sql }),
      });
      if (!res.ok) {
        const err = await res.text();
        console.log(`  ⚠️  SQL warning: ${err.substring(0, 100)}`);
      }
    } catch (e) {
      console.log(`  ⚠️  Migration step failed: ${e.message}`);
    }
  }
}

module.exports = { migrate };
