export { initSchema } from "./schema";
export { getLastCursor, saveCursor, applyEvents, lookupExistingRecords, queryRecords, queryAcrossSources, pruneFeedItems } from "./records";
export type { QueryOptions, SortOption, ExistingRecordInfo } from "./records";
export type { RecordSource } from "../types";
