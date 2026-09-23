import { useEffect, useState } from 'react';

/**
 * The "Recently paid" feed — the homepage section under the hero and the Paid
 * view on /tasks. Off until the stale Samples tasks are settled or closed, so
 * the board and the feed tell the same story (settled-feed spec, rollout step
 * 4). Turning it on is this one constant.
 *
 * Preview it on production before flipping: add `?preview=paid-feed` to any
 * URL. The preview sticks for the browser tab (sessionStorage); `?preview=off`
 * clears it.
 */
export const PAID_FEED_ENABLED = false;

const PREVIEW_KEY = 'ba:preview:paid-feed';

function previewRequested(): boolean {
  try {
    const q = new URLSearchParams(window.location.search).get('preview');
    if (q === 'paid-feed') sessionStorage.setItem(PREVIEW_KEY, '1');
    if (q === 'off') sessionStorage.removeItem(PREVIEW_KEY);
    return sessionStorage.getItem(PREVIEW_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Whether the paid feed renders. The first render (and the prerender) uses the
 * constant, so hydration never mismatches; a preview switches it on after mount.
 */
export function usePaidFeedFlag(): boolean {
  const [on, setOn] = useState(PAID_FEED_ENABLED);
  useEffect(() => {
    if (!PAID_FEED_ENABLED && previewRequested()) setOn(true);
  }, []);
  return on;
}
