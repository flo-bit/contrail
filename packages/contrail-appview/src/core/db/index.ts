export { initSchema, CONTRAIL_SCHEMA_VERSION } from "./schema";
export { getMeta, setMeta, getMetaNumber } from "./meta";
export { optimizeDatabase } from "./optimize";
export { getLastCursor, saveCursor, applyEvents, lookupExistingRecords, queryRecords, queryAcrossSources, pruneFeedItems, pruneActorFeed, sweepFeedItems, getFeedPruneCursor, saveFeedPruneCursor } from "./records";
export type { QueryOptions, SortOption, ExistingRecordInfo, FeedSweepResult } from "./records";
export type { RecordSource } from "../types";
