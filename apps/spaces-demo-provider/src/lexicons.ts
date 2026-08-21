import { NOTE_COLLECTION, REACTION_COLLECTION } from "./constants";

export const noteLexicon = {
  lexicon: 1,
  id: NOTE_COLLECTION,
  defs: {
    main: {
      type: "record",
      key: "tid",
      record: {
        type: "object",
        required: ["text", "createdAt"],
        properties: {
          text: { type: "string", minLength: 1, maxLength: 2000 },
          createdAt: { type: "string", format: "datetime" },
          reply: { type: "ref", ref: "#strongRef" },
        },
      },
    },
    strongRef: {
      type: "object",
      required: ["uri", "cid"],
      properties: {
        uri: { type: "string", format: "uri" },
        cid: { type: "string", format: "cid" },
      },
    },
  },
} as const;

export const reactionLexicon = {
  lexicon: 1,
  id: REACTION_COLLECTION,
  defs: {
    main: {
      type: "record",
      key: "tid",
      record: {
        type: "object",
        required: ["subject", "createdAt"],
        properties: {
          subject: { type: "ref", ref: "#strongRef" },
          createdAt: { type: "string", format: "datetime" },
        },
      },
    },
    strongRef: {
      type: "object",
      required: ["uri", "cid"],
      properties: {
        uri: { type: "string", format: "uri" },
        cid: { type: "string", format: "cid" },
      },
    },
  },
} as const;

export const lexicons = [noteLexicon, reactionLexicon] as const;
