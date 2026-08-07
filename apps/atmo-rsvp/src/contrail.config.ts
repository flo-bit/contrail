import type { ContrailConfig } from "@atmo-dev/contrail";
import { lexicons } from "../lexicons/generated";

export const config: ContrailConfig = {
  namespace: "rsvp.atmo",
  profiles: [],
  constellation: false,
  jetstreams: ["wss://jetstream1.us-east.bsky.network"],
  orderedSource: {
    source: "jetstream",
    epoch: "api-atmo-rsvp-primary-2026-08",
  },
  validation: {
    lexicons: lexicons as unknown as NonNullable<
      ContrailConfig["validation"]
    >["lexicons"],
    strict: true,
    verifyCid: true,
  },
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
  },
};
