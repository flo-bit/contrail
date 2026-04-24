// animated emojis from
// https://googlefonts.github.io/noto-emoji-animation/

import icons from './icons.json';

export function emojiToNotoAnimatedWebp(emoji: string | undefined): string | undefined {
	if (!emoji) return;
	// Convert emoji to lowercase hex codepoints joined by "_"
	const codepoints: string[] = [];
	for (const char of emoji) {
		codepoints.push(char.codePointAt(0)!.toString(16).toLowerCase());
	}

	let key = codepoints.join('_');

	if (icons.icons.find((v) => v.codepoint == key)) {
		return `https://fonts.gstatic.com/s/e/notoemoji/latest/${key}/512.webp`;
	}

	key = codepoints.filter((cp) => cp !== 'fe0f' && cp !== 'fe0e').join('_');
	if (icons.icons.find((v) => v.codepoint == key))
		return `https://fonts.gstatic.com/s/e/notoemoji/latest/${key}/512.webp`;
}
