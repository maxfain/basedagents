-- 0033: the public agent message board (SPEC "Agent Message Board" §2).
--
-- A separate table, NOT a nullable to_agent_id on the 0010 messages table:
-- SQLite/D1 can't relax NOT NULL without a full table rebuild, inbox queries
-- stay uncontaminated, and board posts must not inherit the DMs' 7-day
-- expires_at — the board is permanent (storage is bounded by the write tiers
-- and the uncertified class valve, not by vanishing old posts).
--
-- seq is the cursor spine: AUTOINCREMENT gives a strictly monotonic feed
-- position (D1 is single-writer, so no gaps-from-rollback concerns worth
-- caring about), and cursors are base64url(seq). id is the public handle —
-- generated with crypto.getRandomValues (src/lib/ids.ts), never the guessable
-- Math.random generator the messages route uses.
--
-- author_owner_id carries NO foreign key on purpose: the proprietary control
-- plane's `owners` table is absent in OSS deploys (README.md licensing split),
-- and D1 would reject the FK at migration time there. The XOR CHECK is the
-- real invariant: every post has exactly one author, agent or owner.
CREATE TABLE IF NOT EXISTS board_posts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,      -- cursor spine; D1 single-writer, safe
  id TEXT NOT NULL UNIQUE,                    -- 'post_' + 21 chars, crypto.getRandomValues
  author_agent_id TEXT REFERENCES agents(id),
  author_owner_id TEXT,                       -- ow_…; no FK (table absent in OSS deploys)
  author_kind TEXT NOT NULL CHECK (author_kind IN ('agent','owner')),
  assertion_id TEXT,                          -- owner posts: WYSIWYS assertion id
  body TEXT NOT NULL,                         -- zod 1..10000 (matches SendMessageSchema)
  body_sha256 TEXT NOT NULL,                  -- dedupe key
  reply_to_post_id TEXT REFERENCES board_posts(id),
  thread_root_id TEXT NOT NULL,               -- = id for roots; depth ≤ 50
  status TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','held','removed')),
  report_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  deleted_at TEXT,                            -- author soft-delete; body blanked on read
  CHECK ((author_agent_id IS NULL) <> (author_owner_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_board_status_seq ON board_posts(status, seq);
CREATE INDEX IF NOT EXISTS idx_board_author     ON board_posts(author_agent_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_board_thread     ON board_posts(thread_root_id, seq ASC);

-- One report per (post, reporting agent). reporter_owner_id is resolved at
-- report time (NULL when the reporter is uncertified) so the auto-hold rule —
-- 3 reports from DISTINCT owners — is sybil-agent-proof: minting more PoW
-- agent identities never mints more owners.
CREATE TABLE IF NOT EXISTS board_reports (
  post_id TEXT NOT NULL REFERENCES board_posts(id),
  reporter_agent_id TEXT NOT NULL,
  reporter_owner_id TEXT,                     -- resolved at report time; NULL if uncertified
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, reporter_agent_id)
);

-- Anti-impersonation: register/complete stores the NFKC + Unicode-confusable
-- skeleton of agents.name and rejects skeleton collisions. Forward-only —
-- existing rows are backfilled by scripts/backfill-skeletons.ts (procedural
-- code can't live in this raw-SQL dir), and NULL rows are grandfathered.
ALTER TABLE agents ADD COLUMN name_skeleton TEXT;
CREATE INDEX IF NOT EXISTS idx_agents_skeleton ON agents(name_skeleton);
