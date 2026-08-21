export { initSchema, CONTRAIL_SCHEMA_VERSION } from "./schema";
export { getMeta, setMeta, getMetaNumber } from "./meta";
export { optimizeDatabase } from "./optimize";
export { assertServingSourceCompatibility, getLastCursor, getServingSourcePosition, orderedSourcePosition, saveCursor, saveCursorStatement, getCursorObservations, saveCursorObservationStatements, saveOrderedSourcePositionStatement, saveServingSourcePositionStatement, lookupExistingRecords, queryRecords, pruneFeedItems, pruneActorFeed, sweepFeedItems, getFeedPruneCursor, saveFeedPruneCursor } from "./records";
export type { QueryOptions, SortOption, ExistingRecordInfo, FeedSweepResult, ServingSourcePosition } from "./records";
export type { RecordSource } from "../types";
