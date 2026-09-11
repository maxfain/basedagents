-- 0037: opt-in public deliveries (marketplace social proof, buyer-controlled).
-- Deliverables are private by default; the task poster may publish a specific
-- delivery as a public sample. `published_at` NULL = private (the default),
-- non-null = the content is public. A simple nullable add — no table rebuild.
ALTER TABLE submissions ADD COLUMN published_at TEXT;
