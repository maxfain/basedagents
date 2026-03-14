-- Agent-to-Agent messages
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,                          -- msg_<nanoid>
  from_agent_id TEXT NOT NULL,                  -- sender
  to_agent_id TEXT NOT NULL,                    -- recipient
  type TEXT NOT NULL DEFAULT 'message',         -- 'task_request' | 'message'
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | delivered | read | replied | expired
  callback_url TEXT,
  reply_to_message_id TEXT,                     -- threading
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (from_agent_id) REFERENCES agents(id),
  FOREIGN KEY (to_agent_id) REFERENCES agents(id),
  FOREIGN KEY (reply_to_message_id) REFERENCES messages(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_from_agent ON messages(from_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at);
