/**
 * Badge endpoint — shields.io-compatible SVG badges for agent verification status.
 * GET /v1/agents/:id/badge
 * GET /v1/agents/:id/badge?style=flat (default)
 * GET /v1/agents/:id/badge?style=for-the-badge
 *
 * Based on the shields.io badge specification:
 * https://github.com/badges/shields/blob/master/spec/SPECIFICATION.md
 */
import { Hono } from 'hono';
import type { AppEnv } from '../types/index.js';
import type { DBAdapter } from '../db/adapter.js';

// Shield logo as base64 data URI (16x16 SVG)
const LOGO_URI = 'data:image/svg+xml;base64,' + btoa(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
  '<path d="M8 1L14 3.5v4c0 3.9-2.5 7.5-6 8.5-3.5-1-6-4.6-6-8.5v-4L8 1z" fill="white"/>' +
  '<path d="M7.1 10.3L5.2 8.4l-.9.9 2.8 2.8 5.6-5.6-.9-.9-4.7 4.7z" fill="#333"/>' +
  '</svg>'
);

/**
 * Approximate text width in Verdana at a given font size.
 * Uses character-class widths derived from the shields.io specification.
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
    else w += 6.1; // lowercase
  }
  return w * scale;
}

function flatBadge(label: string, message: string, color: string): string {
  const logoWidth = 14;
  const logoPad = 5;
  const horizPad = 8;
  const labelW = logoPad + logoWidth + 4 + textWidth(label, 11) + horizPad;
  const msgW = horizPad + textWidth(message, 11) + horizPad;
  const totalW = labelW + msgW;
  const labelX = (logoPad + logoWidth + 4 + labelW) / 2 + 1;
  const msgX = labelW + msgW / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(totalW)}" height="20" role="img" aria-label="${label}: ${message}">` +
    `<title>${label}: ${message}</title>` +
    `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>` +
    `<clipPath id="r"><rect width="${Math.round(totalW)}" height="20" rx="3" fill="#fff"/></clipPath>` +
    `<g clip-path="url(#r)">` +
    `<rect width="${Math.round(labelW)}" height="20" fill="#555"/>` +
    `<rect x="${Math.round(labelW)}" width="${Math.round(msgW)}" height="20" fill="${color}"/>` +
    `<rect width="${Math.round(totalW)}" height="20" fill="url(#s)"/>` +
    `</g>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">` +
    `<image x="${logoPad}" y="3" width="${logoWidth}" height="${logoWidth}" href="${LOGO_URI}"/>` +
    `<text aria-hidden="true" x="${Math.round(labelX * 10)}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${Math.round(textWidth(label, 11) * 10)}">${label}</text>` +
    `<text x="${Math.round(labelX * 10)}" y="140" transform="scale(.1)" fill="#fff" textLength="${Math.round(textWidth(label, 11) * 10)}">${label}</text>` +
    `<text aria-hidden="true" x="${Math.round(msgX * 10)}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${Math.round(textWidth(message, 11) * 10)}">${message}</text>` +
    `<text x="${Math.round(msgX * 10)}" y="140" transform="scale(.1)" fill="#fff" textLength="${Math.round(textWidth(message, 11) * 10)}">${message}</text>` +
    `</g></svg>`;
}

function forTheBadge(label: string, message: string, color: string): string {
  const logoWidth = 14;
  const logoPad = 9;
  const horizPad = 12;
  const labelUpper = label.toUpperCase();
  const msgUpper = message.toUpperCase();
  const labelW = logoPad + logoWidth + 5 + textWidth(labelUpper, 10) + horizPad;
  const msgW = horizPad + textWidth(msgUpper, 10) + horizPad;
  const totalW = labelW + msgW;
  const labelX = (logoPad + logoWidth + 5 + labelW) / 2 + 1;
  const msgX = labelW + msgW / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(totalW)}" height="28" role="img" aria-label="${labelUpper}: ${msgUpper}">` +
    `<title>${labelUpper}: ${msgUpper}</title>` +
    `<g shape-rendering="crispEdges">` +
    `<rect width="${Math.round(labelW)}" height="28" fill="#555"/>` +
    `<rect x="${Math.round(labelW)}" width="${Math.round(msgW)}" height="28" fill="${color}"/>` +
    `</g>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="100">` +
    `<image x="${logoPad}" y="7" width="${logoWidth}" height="${logoWidth}" href="${LOGO_URI}"/>` +
    `<text transform="scale(.1)" x="${Math.round(labelX * 10)}" y="175" textLength="${Math.round(textWidth(labelUpper, 10) * 10)}" fill="#fff">${labelUpper}</text>` +
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
    ? forTheBadge('basedagents', message, color)
    : flatBadge('basedagents', message, color);

  c.header('Content-Type', 'image/svg+xml');
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(svg);
});

export default badge;
