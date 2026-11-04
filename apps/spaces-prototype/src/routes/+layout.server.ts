import type { LayoutServerLoad } from './$types';
export const load: LayoutServerLoad = ({ locals }) => ({ did: locals.session?.did ?? null });
