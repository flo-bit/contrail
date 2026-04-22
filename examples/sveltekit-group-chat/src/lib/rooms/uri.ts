/** Helpers for assembling space URIs in the `tools.atmo.chat` namespace. */

const SPACE_TYPE = 'tools.atmo.chat.space';

export function buildSpaceUri(communityDid: string, key: string): string {
	return `at://${communityDid}/${SPACE_TYPE}/${key}`;
}

export function buildMembersUri(communityDid: string): string {
	return buildSpaceUri(communityDid, 'members');
}

export function buildAdminUri(communityDid: string): string {
	return buildSpaceUri(communityDid, '$admin');
}

const SPACE_URI_RE = new RegExp(`^at://([^/]+)/${SPACE_TYPE.replace(/\./g, '\\.')}/([^/]+)$`);

export function parseSpaceUri(uri: string): { communityDid: string; key: string } | null {
	const m = SPACE_URI_RE.exec(uri);
	if (!m) return null;
	return { communityDid: m[1]!, key: m[2]! };
}
