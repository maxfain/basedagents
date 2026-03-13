/**
 * Badge endpoint — shields.io-compatible SVG badges for agent verification status.
 * GET /v1/agents/:id/badge
 * GET /v1/agents/:id/badge?style=flat (default)
 * GET /v1/agents/:id/badge?style=for-the-badge
 *
 * Uses the basedagents diamond logo mark instead of text on the left side.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../types/index.js';
import type { DBAdapter } from '../db/adapter.js';

// BasedAgents diamond/chevron logo as base64 SVG data URI
// Diamond shape with <> chevron cutout, purple #7B6CF6
const LOGO_URI = 'data:image/svg+xml;base64,' + btoa(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
  '<path d="M12 2L22 12L12 22L2 12Z" fill="#7B6CF6"/>' +
  '<path d="M9.5 8.5L6.5 12L9.5 15.5" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
  '<path d="M14.5 8.5L17.5 12L14.5 15.5" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
  '</svg>'
);

/**
 * Approximate text width in Verdana at a given font size.
 */
function textWidth(text: string, fontSize: number): number {
  const scale = fontSize / 11;
  let w = 0;
  for (const ch of text) {
    if (ch === ' ') w += 3.3;
    else if (ch >= 'A' && ch <= 'Z') w += 7.6;
    else if (ch >= '0' && ch <= '9') w += 6.5;
    else if (ch === '(' || ch === ')') w += 3.9;
    else if (ch === '.') w += 3.3;
    else w += 6.1;
  }
  return w * scale;
}

function flatBadge(message: string, color: string): string {
  const logoSize = 14;
  const logoPad = 4;
  const labelW = logoPad + logoSize + logoPad; // logo only, no text
  const horizPad = 8;
  const msgW = horizPad + textWidth(message, 11) + horizPad;
  const totalW = labelW + msgW;
  const msgX = labelW + msgW / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(totalW)}" height="20" role="img" aria-label="basedagents: ${message}">` +
    `<title>basedagents: ${message}</title>` +
    `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>` +
    `<clipPath id="r"><rect width="${Math.round(totalW)}" height="20" rx="3" fill="#fff"/></clipPath>` +
    `<g clip-path="url(#r)">` +
    `<rect width="${Math.round(labelW)}" height="20" fill="#555"/>` +
    `<rect x="${Math.round(labelW)}" width="${Math.round(msgW)}" height="20" fill="${color}"/>` +
    `<rect width="${Math.round(totalW)}" height="20" fill="url(#s)"/>` +
    `</g>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">` +
    `<image x="${logoPad}" y="3" width="${logoSize}" height="${logoSize}" href="${LOGO_URI}"/>` +
    `<text aria-hidden="true" x="${Math.round(msgX * 10)}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${Math.round(textWidth(message, 11) * 10)}">${message}</text>` +
    `<text x="${Math.round(msgX * 10)}" y="140" transform="scale(.1)" fill="#fff" textLength="${Math.round(textWidth(message, 11) * 10)}">${message}</text>` +
    `</g></svg>`;
}

function forTheBadge(message: string, color: string): string {
  const logoSize = 18;
  const logoPad = 6;
  const labelW = logoPad + logoSize + logoPad;
  const horizPad = 12;
  const msgUpper = message.toUpperCase();
  const msgW = horizPad + textWidth(msgUpper, 10) + horizPad;
  const totalW = labelW + msgW;
  const msgX = labelW + msgW / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(totalW)}" height="28" role="img" aria-label="basedagents: ${msgUpper}">` +
    `<title>basedagents: ${msgUpper}</title>` +
    `<g shape-rendering="crispEdges">` +
    `<rect width="${Math.round(labelW)}" height="28" fill="#555"/>` +
    `<rect x="${Math.round(labelW)}" width="${Math.round(msgW)}" height="28" fill="${color}"/>` +
    `</g>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="100">` +
    `<image x="${logoPad}" y="5" width="${logoSize}" height="${logoSize}" href="${LOGO_URI}"/>` +
    `<text transform="scale(.1)" x="${Math.round(msgX * 10)}" y="175" textLength="${Math.round(textWidth(msgUpper, 10) * 10)}" fill="#fff" font-weight="bold">${msgUpper}</text>` +
    `</g></svg>`;
}

const badge = new Hono<AppEnv>();

badge.get('/:id/badge', async (c) => {
  const id = c.req.param('id');
  const style = c.req.query('style') ?? 'flat';
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

  const svg = style === 'for-the-badge'
    ? forTheBadge(message, color)
    : flatBadge(message, color);

  c.header('Content-Type', 'image/svg+xml');
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(svg);
});

export default badge;
