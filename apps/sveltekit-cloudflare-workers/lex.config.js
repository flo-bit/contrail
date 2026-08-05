import { defineLexiconConfig } from '@atcute/lex-cli';

export default defineLexiconConfig({
	generate: {
		files: [
			'lexicons/generated/**/*.json',
			'lexicons/pulled/xyz/**/*.json'
		],
		outdir: 'src/lib/lexicons',
		imports: ['@atcute/atproto', '@atcute/bluesky']
	}
});
