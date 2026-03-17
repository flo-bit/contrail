import type { ContrailConfig } from "./core/types";

export const config: ContrailConfig = {
  namespace: "rsvp.atmo",
  collections: {
    "community.lexicon.calendar.event": {
      relations: {
        rsvps: {
          collection: "community.lexicon.calendar.rsvp",
          groupBy: "status",
        },
      },
    },
    "community.lexicon.calendar.rsvp": {
      relations: {
        event: {
          collection: "community.lexicon.calendar.event",
          field: "subject.uri",
        },
      },
    },
  },
};
