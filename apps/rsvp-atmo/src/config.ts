import type { ContrailConfig } from "@atmo-dev/contrail";

export const config: ContrailConfig = {
  namespace: "rsvp.atmo",
  jetstreams: ["wss://jetstream1.us-east.bsky.network"],
  spaces: {
    type: "tools.atmo.event.space",
    serviceDid: "did:web:rsvp.atmo",
  },
  community: {
    // 32-byte master key for envelope-encrypting stored credentials (app
    // passwords + minted signing/rotation keys). Provide via env: hex or
    // base64 encoded. For Cloudflare Workers, wire from env.COMMUNITY_MASTER_KEY
    // via a config factory pattern. The placeholder below is fine for `pnpm
    // generate` (which never instantiates the cipher) but must be replaced
    // before starting the server.
    masterKey:
      (typeof process !== "undefined" ? process.env.COMMUNITY_MASTER_KEY : undefined) ??
      "placeholder-set-me-before-running-server-not-at-build-time",
  },
  collections: {
    event: {
      collection: "community.lexicon.calendar.event",
      queryable: {
        mode: {},
        name: {},
        status: {},
        startsAt: { type: "range" },
        endsAt: { type: "range" },
        createdAt: { type: "range" },
      },
      searchable: ["name", "description"],
      relations: {
        rsvps: {
          collection: "rsvp",
          groupBy: "status",
          count: true,
          countDistinct: "did",
          groups: {
            interested: "community.lexicon.calendar.rsvp#interested",
            going: "community.lexicon.calendar.rsvp#going",
            notgoing: "community.lexicon.calendar.rsvp#notgoing",
          },
        },
      },
    },
    rsvp: {
      collection: "community.lexicon.calendar.rsvp",
      queryable: {
        status: {},
        "subject.uri": {},
      },
      references: {
        event: {
          collection: "event",
          field: "subject.uri",
        },
      },
    },
  },

  profiles: [
    "app.bsky.actor.profile"
  ]
};
