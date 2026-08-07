import { defineLexiconConfig } from "@atcute/lex-cli";

export default defineLexiconConfig({
  generate: {
    files: [
      "lexicons/custom/**/*.json",
      "lexicons/pulled/**/*.json",
      "lexicons/generated/**/*.json",
    ],
    outdir: "src/lexicon-types/",
  },
  pull: {
    outdir: "lexicons/pulled/",
    clean: true,
    sources: [
      {
        type: "atproto",
        mode: "nsids",
        nsids: [
          "com.atproto.repo.strongRef",
          "community.lexicon.calendar.event",
          "community.lexicon.calendar.rsvp",
          "community.lexicon.location.address",
          "community.lexicon.location.fsq",
          "community.lexicon.location.geo",
          "community.lexicon.location.hthree"
        ],
      },
    ],
  },
});
