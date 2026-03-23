import type { ContrailConfig } from "./core/types";

export const config: ContrailConfig = {
  namespace: "rsvp.atmo",
  collections: {
    "community.lexicon.calendar.event": {
      searchable: ["name", "description"],
      relations: {
        rsvps: {
          collection: "community.lexicon.calendar.rsvp",
          groupBy: "status",
          count: true,
        },
      },
    },
    "community.lexicon.calendar.rsvp": {
      references: {
        event: {
          collection: "community.lexicon.calendar.event",
          field: "subject.uri",
        },
      },
    },
  },
  // feeds: {
  //   following: {
  //     follow: "app.bsky.graph.follow",
  //     targets: [
  //       "community.lexicon.calendar.event",
  //       "community.lexicon.calendar.rsvp",
  //     ],
  //   },
  // },
};
