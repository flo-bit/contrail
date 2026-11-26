import { MODERATION_ACTION_NSID } from "../core/moderation";

export const moderationActionLexicon = {
  lexicon: 1,
  id: MODERATION_ACTION_NSID,
  defs: {
    main: {
      type: "record",
      key: "tid",
      record: {
        type: "object",
        required: ["subject", "action", "createdAt"],
        properties: {
          subject: { type: "string", maxLength: 8192 },
          subjectCid: { type: "string", format: "cid" },
          action: { type: "string", maxLength: 128 },
          expiresAt: { type: "string", format: "datetime" },
          createdAt: { type: "string", format: "datetime" },
        },
      },
    },
  },
};

/** Standard report procedure plus the two instance-private inbox methods. */
export function moderationLexicons(namespace: string): object[] {
  const json = (schema: object) => ({ encoding: "application/json", schema });
  return [
    moderationActionLexicon,
    {
      lexicon: 1,
      id: "com.atproto.moderation.createReport",
      defs: {
        main: {
          type: "procedure",
          input: json({
            type: "object",
            required: ["reasonType", "subject"],
            properties: {
              reasonType: {
                type: "ref",
                ref: "com.atproto.moderation.defs#reasonType",
              },
              reason: { type: "string", maxGraphemes: 2000, maxLength: 20000 },
              subject: {
                type: "union",
                refs: [
                  "com.atproto.admin.defs#repoRef",
                  "com.atproto.repo.strongRef",
                ],
              },
            },
          }),
          output: json({
            type: "object",
            required: [
              "id",
              "reasonType",
              "subject",
              "reportedBy",
              "createdAt",
            ],
            properties: {
              id: { type: "integer" },
              reasonType: {
                type: "ref",
                ref: "com.atproto.moderation.defs#reasonType",
              },
              reason: { type: "string" },
              subject: {
                type: "union",
                refs: [
                  "com.atproto.admin.defs#repoRef",
                  "com.atproto.repo.strongRef",
                ],
              },
              reportedBy: { type: "string", format: "did" },
              createdAt: { type: "string", format: "datetime" },
            },
          }),
        },
      },
    },
    {
      lexicon: 1,
      id: `${namespace}.moderation.listReports`,
      defs: {
        main: {
          type: "query",
          parameters: {
            type: "params",
            properties: {
              status: {
                type: "string",
                enum: ["open", "resolved"],
                default: "open",
              },
              limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
              cursor: { type: "string" },
            },
          },
          output: json({
            type: "object",
            required: ["reports"],
            properties: {
              reports: { type: "array", items: { type: "unknown" } },
              cursor: { type: "string" },
            },
          }),
        },
      },
    },
    {
      lexicon: 1,
      id: `${namespace}.moderation.resolveReport`,
      defs: {
        main: {
          type: "procedure",
          input: json({
            type: "object",
            required: ["id"],
            properties: {
              id: { type: "integer", minimum: 0 },
              resolution: { type: "string", maxLength: 4000 },
              actionUri: { type: "string", format: "at-uri" },
            },
          }),
          output: json({ type: "object", properties: {} }),
        },
      },
    },
  ];
}
