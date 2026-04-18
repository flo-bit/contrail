import type { ContrailConfig } from "../src/index";

export const config: ContrailConfig = {
  namespace: "rsvp.atmo",
  spaces: {
    type: "tools.atmo.event.space",
    serviceDid: "did:web:rsvp.atmo",
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
    "app.bsky.actor.profile",
    { collection: "site.standard.publication", rkey: "blento.self" }
  ]
};
