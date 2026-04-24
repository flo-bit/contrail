/** Helpers for assembling space URIs in the `tools.atmo.chat` namespace.
 *
 *  The URIs are returned as `ResourceUri` (branded) so they flow into
 *  lexicon-typed XRPC params without per-call casts. We apply the brand
 *  once here — structurally these are just `at://…` strings. */

import type { ResourceUri } from '@atcute/lexicons';

const SPACE_TYPE = 'tools.atmo.chat.space';

export function buildSpaceUri(communityDid: string, key: string): ResourceUri {
	return `at://${communityDid}/${SPACE_TYPE}/${key}` as ResourceUri;
}

export function buildMembersUri(communityDid: string): ResourceUri {
	return buildSpaceUri(communityDid, 'members');
}

export function buildAdminUri(communityDid: string): ResourceUri {
	return buildSpaceUri(communityDid, '$admin');
}

const SPACE_URI_RE = new RegExp(`^at://([^/]+)/${SPACE_TYPE.replace(/\./g, '\\.')}/([^/]+)$`);

export function parseSpaceUri(uri: string): { communityDid: string; key: string } | null {
	const m = SPACE_URI_RE.exec(uri);
	if (!m) return null;
	return { communityDid: m[1]!, key: m[2]! };
}
