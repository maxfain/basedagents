/**
 * Fire-and-forget Twitter/X posting via OAuth 1.0a.
 * Uses Web Crypto (crypto.subtle) — compatible with Cloudflare Workers.
 * Never throws; logs errors silently so a Twitter failure never breaks the API.
 */

export interface TwitterCreds {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessSecret: string;
}

function pct(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

async function hmacSha1(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export async function postTweet(text: string, creds: TwitterCreds): Promise<void> {
  try {
    const url = 'https://api.twitter.com/2/tweets';
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
      .replace(/[^A-Za-z0-9]/g, '');

    const oauth: Record<string, string> = {
      oauth_consumer_key: creds.consumerKey,
      oauth_nonce: nonce,
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: ts,
      oauth_token: creds.accessToken,
      oauth_version: '1.0',
    };

    const paramStr = Object.entries(oauth)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${pct(k)}=${pct(v)}`)
      .join('&');

    const base = `POST&${pct(url)}&${pct(paramStr)}`;
    const sigKey = `${pct(creds.consumerSecret)}&${pct(creds.accessSecret)}`;
    const sig = await hmacSha1(sigKey, base);
    oauth['oauth_signature'] = sig;

    const authHeader = 'OAuth ' + Object.entries(oauth)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${pct(k)}="${pct(v)}"`)
      .join(', ');

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[twitter] post failed ${res.status}: ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.error('[twitter] post error:', err);
  }
}

/** Build tweet text for a new agent registration. */
export function registrationTweet(agent: {
  name: string;
  x_handle?: string | null;
  capabilities: string[];
  agent_id: string;
}): string {
  const mention = agent.x_handle ? ` ${agent.x_handle.startsWith('@') ? agent.x_handle : '@' + agent.x_handle}` : '';
  const caps = agent.capabilities.slice(0, 3).join(', ');
  const url = `https://basedagents.ai/whois/${agent.agent_id}`;
  return `New agent registered on basedagents.ai: ${agent.name}${mention}\nCapabilities: ${caps}\n${url}`;
}

/** Build tweet text for an agent's first verification. */
export function firstVerificationTweet(agent: {
  name: string;
  x_handle?: string | null;
  reputation_score: number;
  agent_id: string;
}): string {
  const mention = agent.x_handle ? ` ${agent.x_handle.startsWith('@') ? agent.x_handle : '@' + agent.x_handle}` : '';
  const rep = agent.reputation_score.toFixed(3);
  const url = `https://basedagents.ai/whois/${agent.agent_id}`;
  return `${agent.name}${mention} just received their first verification on basedagents.ai\nReputation: ${rep}\n${url}`;
}
