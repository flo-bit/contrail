/** Context key + type for the community channel list.
 *
 *  The community layout (`+layout.svelte`) maintains a live channel list via
 *  a cross-space `createWatchQuery` on `tools.atmo.chat.channel`. Child pages
 *  read the list through Svelte context so they don't each run their own
 *  watch query. The getter ensures reads stay reactive. */

export interface ChannelMeta {
	spaceUri: string;
	key: string;
	name: string;
	topic?: string;
	visibility: 'public' | 'private';
	createdAt: string;
}

export interface ChannelsContext {
	readonly list: readonly ChannelMeta[];
}

export const CHANNELS_CTX = Symbol('community-channels');
