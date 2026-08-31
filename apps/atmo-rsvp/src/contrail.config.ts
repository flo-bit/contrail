import type { ContrailConfig } from "@atmo-dev/contrail";

export const config: ContrailConfig = {
  namespace: "rsvp.atmo",
  profiles: ["app.bsky.actor.profile"],
  jetstreams: ["https://jetstream.us-east.bsky.network"],
  orderedSource: {
    source: "jetstream",
    epoch: "api-atmo-rsvp-primary-v2-2026-08",
  },
  notify: true,
  serviceAuth: {
    audience: "did:web:api.atmo.rsvp#contrail",
    methods: ["getFeed", "notifyOfUpdate"],
  },
  maintenance: { optimize: true },
  collections: {
    event: {
      collection: "community.lexicon.calendar.event",
      queryable: {
        mode: {},
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
          groups: {
            going: "community.lexicon.calendar.rsvp#going",
            interested: "community.lexicon.calendar.rsvp#interested",
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
        createdAt: { type: "range" },
      },
      references: {
        event: {
          collection: "event",
          field: "subject.uri",
        },
      },
    },
    profile: {
      collection: "app.bsky.actor.profile",
      discover: false,
      methods: [],
    },
    follow: {
      collection: "app.bsky.graph.follow",
      discover: false,
      subjectField: "subject",
      methods: [],
    },
  },
  feeds: {
    network: {
      targets: [
        { collection: "event", maxItems: 100 },
        { collection: "rsvp", maxItems: 250 },
      ],
    },
  },
};

/** Candidate-generation configuration for the Meilisearch reference consumer.
 * The active Worker keeps `config` until a fresh D1 + candidate index are built
 * and activated together. */
export const searchGenerationConfig: ContrailConfig = {
  ...config,
  changes: {
    consumers: {
      search: {
        collections: ["community.lexicon.calendar.event"],
        phases: ["historical", "live"],
        initial: "current",
        requiredForActivation: true,
      },
    },
  },
};
