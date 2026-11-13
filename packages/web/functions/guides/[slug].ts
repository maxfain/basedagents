// /guides/:slug — a real 404 for unknown Agent Atlas slugs; known routes pass through (src/atlas/guard.ts).
import { atlasGuard, type AtlasGuardContext } from '../../src/atlas/guard';
import { ROOT_HEADERS } from '../headers.generated';

export const onRequest = (ctx: AtlasGuardContext): Promise<Response> => atlasGuard(ctx, ROOT_HEADERS);
