async function migrate(supabaseConfig) {
  const { url, serviceKey } = supabaseConfig;

  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal',
  };

  // Enable pgvector extension
  const sqlStatements = [
    // Enable vector extension
    `CREATE EXTENSION IF NOT EXISTS vector;`,

    // Memory table
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

    // Index for faster vector search
    `CREATE INDEX IF NOT EXISTS obol_memory_embedding_idx ON obol_memory
      USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);`,

    // Index for date queries
    `CREATE INDEX IF NOT EXISTS obol_memory_created_at_idx ON obol_memory (created_at);`,

    // Index for category filtering
    `CREATE INDEX IF NOT EXISTS obol_memory_category_idx ON obol_memory (category);`,

    // Enable RLS
    `ALTER TABLE obol_memory ENABLE ROW LEVEL SECURITY;`,

    // RLS policy — service role has full access
    `DO $$ BEGIN
      CREATE POLICY "service_role_all" ON obol_memory FOR ALL TO service_role USING (true) WITH CHECK (true);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;`,
  ];

  // Execute via Supabase SQL endpoint
  for (const sql of sqlStatements) {
    const res = await fetch(`${url}/rest/v1/rpc/`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
    });

    // If rpc endpoint doesn't work, try the SQL editor API
    if (!res.ok) {
      // Fall back to executing via pg direct if available
      // For now, print the SQL for manual execution
    }
  }

  // Alternative: use supabase-js to run SQL
  // Most reliable way is to use the management API
  const mgmtRes = await fetch(`${url}/rest/v1/`, { headers: { apikey: serviceKey } });
  if (mgmtRes.ok) {
    // Try to create table via PostgREST (won't work for DDL)
    // We need the SQL editor endpoint or supabase CLI
  }

  // Best approach: output SQL file for user to run
  const fs = require('fs');
  const path = require('path');
  const { OBOL_DIR } = require('../config');
  const sqlFile = path.join(OBOL_DIR, 'migrations', 'init.sql');
  fs.mkdirSync(path.dirname(sqlFile), { recursive: true });
  fs.writeFileSync(sqlFile, sqlStatements.join('\n\n'));

  // Try executing via Supabase Management API
  const accessToken = supabaseConfig.accessToken;
  if (accessToken) {
    // Extract project ref from URL
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
          // IVFFlat index may fail if table is empty — that's fine
          if (sql.includes('ivfflat') && err.includes('not enough')) continue;
          console.log(`  ⚠️  SQL warning: ${err.substring(0, 100)}`);
        }
      } catch (e) {
        console.log(`  ⚠️  Migration step failed: ${e.message}`);
      }
    }
    return;
  }

  console.log(`\n  ⚠️  Could not run migrations automatically.`);
  console.log(`  Run this SQL in your Supabase dashboard (SQL Editor):`);
  console.log(`  File saved to: ${sqlFile}\n`);
}

module.exports = { migrate };
