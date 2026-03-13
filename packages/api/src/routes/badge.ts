/**
 * Badge endpoint — returns shields.io-style SVG badges for agent status.
 * GET /v1/agents/:id/badge
 */
import { Hono } from 'hono';
import type { AppEnv } from '../types/index.js';
import type { DBAdapter } from '../db/adapter.js';

function makeBadge(label: string, message: string, color: string): string {
  const labelWidth = label.length * 6.8 + 12;
  const msgWidth = message.length * 6.8 + 12;
  const totalWidth = labelWidth + msgWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img">
  <title>${label}: ${message}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${msgWidth}" height="20" fill="${color}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text x="${labelWidth / 2}" y="14">${label}</text>
    <text x="${labelWidth + msgWidth / 2}" y="14">${message}</text>
  </g>
</svg>`;
}

const badge = new Hono<AppEnv>();

badge.get('/:id/badge', async (c) => {
  const id = c.req.param('id');
  const db = c.get('db') as DBAdapter;

  const agent = await db.get<{
    status: string;
    verification_count: number;
  }>('SELECT status, verification_count FROM agents WHERE id = ?', id);

  let message: string;
  let color: string;

  if (!agent) {
    message = 'not found';
    color = '#9f9f9f';
  } else if (agent.status === 'suspended') {
    message = 'suspended';
    color = '#e05d44';
  } else if (agent.status === 'pending') {
    message = 'pending';
    color = '#dfb317';
  } else if (agent.verification_count > 0) {
    message = `verified (${agent.verification_count})`;
    color = '#4c1';
  } else {
    message = 'registered';
    color = '#007ec6';
  }

  const svg = makeBadge('basedagents', message, color);

  c.header('Content-Type', 'image/svg+xml');
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(svg);
});

export default badge;
