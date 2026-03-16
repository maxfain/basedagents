/**
 * Validate that a URL is safe to fetch (not targeting internal/private resources).
 * Returns true if the URL is safe, false otherwise.
 */
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    // Must be HTTPS
    if (parsed.protocol !== 'https:') return false;

    const hostname = parsed.hostname.toLowerCase();

    // Block cloud metadata endpoints
    const metadataHosts = ['metadata.google.internal', 'metadata.google', '169.254.169.254'];
    if (metadataHosts.includes(hostname)) return false;

    // Block private/reserved IPs
    if (isPrivateHostname(hostname)) return false;

    return true;
  } catch {
    return false;
  }
}

function isPrivateHostname(hostname: string): boolean {
  // IPv4 private ranges
  if (/^127\./.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^169\.254\./.test(hostname)) return true;
  if (hostname === 'localhost') return true;
  if (hostname === '0.0.0.0') return true;

  // IPv6 private
  if (hostname === '[::1]' || hostname === '::1') return true;
  if (hostname.startsWith('[fc') || hostname.startsWith('[fd')) return true;
  if (hostname.startsWith('fc') || hostname.startsWith('fd')) return true;

  return false;
}
