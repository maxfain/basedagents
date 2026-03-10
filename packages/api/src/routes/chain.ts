import { Hono } from 'hono';
import type { AppEnv, ChainEntry } from '../types/index.js';
import { GENESIS_HASH, bytesToHex } from '../crypto/index.js';

const chain = new Hono<AppEnv>();

/**
 * Format a chain entry row for API response.
 */
function formatChainEntry(entry: ChainEntry) {
  // public_key comes as Uint8Array (or ArrayBuffer from D1) — convert to hex
  const pkBytes = entry.public_key instanceof Uint8Array
    ? entry.public_key
    : new Uint8Array(entry.public_key as ArrayBufferLike);
  return {
    sequence: entry.sequence,
    entry_hash: entry.entry_hash,
    previous_hash: entry.previous_hash,
    agent_id: entry.agent_id,
    public_key: bytesToHex(pkBytes),
    nonce: entry.nonce,
    profile_hash: entry.profile_hash,
    timestamp: entry.timestamp,
  };
}

/**
 * GET /v1/chain/latest
 * Returns the latest chain entry hash + sequence number.
 */
chain.get('/latest', async (c) => {
  const db = c.get('db');

  const latest = await db.get<ChainEntry>(
    'SELECT * FROM chain ORDER BY sequence DESC LIMIT 1'
  );

  if (!latest) {
    return c.json({
      sequence: 0,
      entry_hash: GENESIS_HASH,
      message: 'Chain is empty — genesis state',
    });
  }

  return c.json(formatChainEntry(latest));
});

/**
 * GET /v1/chain?from=N&to=M
 * Returns a range of chain entries. If no from/to, returns latest 20.
 */
chain.get('/', async (c) => {
  const db = c.get('db');

  const fromStr = c.req.query('from');
  const toStr = c.req.query('to');

  if (!fromStr && !toStr) {
    const entries = await db.all<ChainEntry>(
      'SELECT * FROM chain ORDER BY sequence DESC LIMIT 20'
    );
    const countRow = await db.get<{ count: number }>('SELECT COUNT(*) as count FROM chain');

    return c.json({
      entries: entries.map(formatChainEntry),
      total: countRow?.count ?? 0,
    });
  }

  const from = fromStr ? parseInt(fromStr, 10) : 1;
  const to = toStr ? parseInt(toStr, 10) : from + 99;

  if (isNaN(from) || isNaN(to) || from < 1 || to < from) {
    return c.json({ error: 'bad_request', message: 'Invalid range — from must be >= 1 and to >= from' }, 400);
  }

  const cappedTo = Math.min(to, from + 999);

  const entries = await db.all<ChainEntry>(
    'SELECT * FROM chain WHERE sequence >= ? AND sequence <= ? ORDER BY sequence ASC',
    from, cappedTo
  );

  return c.json({
    entries: entries.map(formatChainEntry),
    from,
    to: cappedTo,
  });
});

/**
 * GET /v1/chain/:sequence
 * Returns a specific chain entry by sequence number.
 */
chain.get('/:sequence', async (c) => {
  const seqStr = c.req.param('sequence');

  if (seqStr === 'latest') {
    return c.json({ error: 'bad_request', message: 'Use /v1/chain/latest endpoint' }, 400);
  }

  const sequence = parseInt(seqStr, 10);
  if (isNaN(sequence) || sequence < 1) {
    return c.json({ error: 'bad_request', message: 'Invalid sequence number' }, 400);
  }

  const db = c.get('db');
  const entry = await db.get<ChainEntry>(
    'SELECT * FROM chain WHERE sequence = ?',
    sequence
  );

  if (!entry) {
    return c.json({ error: 'not_found', message: `Chain entry ${sequence} not found` }, 404);
  }

  return c.json(formatChainEntry(entry));
});

export default chain;
