/**
 * Badge endpoint — returns a styled SVG badge for agent verification status.
 * GET /v1/agents/:id/badge
 */
import { Hono } from 'hono';
import type { AppEnv } from '../types/index.js';
import type { DBAdapter } from '../db/adapter.js';

// Shield icon (16x16) as inline SVG path
const shieldIcon = `<path d="M9.5 2.1L16 5v4.5c0 4.4-2.8 8.5-6.5 10-3.7-1.5-6.5-5.6-6.5-10V5l6.5-2.9z" fill="rgba(255,255,255,0.9)" transform="translate(8,4) scale(0.75)"/>`;

function measureText(text: string): number {
  // Approximate width for 12px bold sans-serif
  let width = 0;
  for (const ch of text) {
    if (ch === ' ') width += 3.5;
    else if (ch >= '0' && ch <= '9') width += 7.2;
    else if (ch === ch.toUpperCase() && ch !== ch.toLowerCase()) width += 8;
    else if (ch === '(' || ch === ')') width += 4.5;
    else width += 6.8;
  }
  return width;
}

function makeBadge(message: string, color: string): string {
  const label = 'basedagents';
  const leftPad = 28; // space for icon
  const labelTextWidth = measureText(label);
  const labelWidth = leftPad + labelTextWidth + 14;
  const msgTextWidth = measureText(message);
  const msgWidth = msgTextWidth + 24;
  const totalWidth = labelWidth + msgWidth;
  const height = 28;
  const radius = 6;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${height}" role="img" aria-label="${label}: ${message}">
  <title>${label}: ${message}</title>
  <defs>
    <linearGradient id="bg" x2="0" y2="100%">
      <stop offset="0" stop-color="#4a4a4a"/>
      <stop offset="1" stop-color="#333"/>
    </linearGradient>
    <linearGradient id="st" x2="0" y2="100%">
      <stop offset="0" stop-color="${color}" stop-opacity="1"/>
      <stop offset="1" stop-color="${color}" stop-opacity="0.85"/>
    </linearGradient>
  </defs>
  <clipPath id="r"><rect width="${totalWidth}" height="${height}" rx="${radius}"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="${height}" fill="url(#bg)"/>
    <rect x="${labelWidth}" width="${msgWidth}" height="${height}" fill="url(#st)"/>
  </g>
  <g>
    ${shieldIcon}
    <g fill="#fff" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif" font-size="12" font-weight="600">
      <text x="${leftPad + labelTextWidth / 2}" y="18">${label}</text>
      <text x="${labelWidth + msgWidth / 2}" y="18">${message}</text>
    </g>
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
    color = '#8a8a8a';
  } else if (agent.status === 'suspended') {
    message = 'suspended';
    color = '#e05d44';
  } else if (agent.status === 'pending') {
    message = 'pending';
    color = '#c4a000';
  } else if (agent.verification_count > 0) {
    message = `verified (${agent.verification_count})`;
    color = '#3fb950';
  } else {
    message = 'registered';
    color = '#388bfd';
  }

  const svg = makeBadge(message, color);

  c.header('Content-Type', 'image/svg+xml');
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(svg);
});

export default badge;
