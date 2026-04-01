import type { ContrailConfig } from "@atmo-dev/contrail";

export const config: ContrailConfig = {
  namespace: "rsvp.atmo",
  collections: {
    "community.lexicon.calendar.event": {
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
          collection: "community.lexicon.calendar.rsvp",
          groupBy: "status",
          count: true,
          groups: {
            interested: "community.lexicon.calendar.rsvp#interested",
            going: "community.lexicon.calendar.rsvp#going",
            notgoing: "community.lexicon.calendar.rsvp#notgoing",
          },
        },
      },
    },
    "community.lexicon.calendar.rsvp": {
      queryable: {
        status: {},
        "subject.uri": {},
      },
      references: {
        event: {
          collection: "community.lexicon.calendar.event",
          field: "subject.uri",
        },
      },
    },
  },
};
