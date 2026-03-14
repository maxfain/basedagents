-- Task Marketplace
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  creator_agent_id TEXT NOT NULL,
  claimed_by_agent_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT,
  required_capabilities TEXT,
  expected_output TEXT,
  output_format TEXT DEFAULT 'json',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','submitted','verified','closed','cancelled')),
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  submitted_at TEXT,
  verified_at TEXT,
  FOREIGN KEY (creator_agent_id) REFERENCES agents(id),
  FOREIGN KEY (claimed_by_agent_id) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS submissions (
  submission_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  submission_type TEXT NOT NULL DEFAULT 'json' CHECK (submission_type IN ('json','link')),
  content TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks(category);
CREATE INDEX IF NOT EXISTS idx_tasks_creator ON tasks(creator_agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_claimer ON tasks(claimed_by_agent_id);
CREATE INDEX IF NOT EXISTS idx_submissions_task ON submissions(task_id);
