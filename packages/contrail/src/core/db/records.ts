/** Barrel re-exporting Contrail's record storage modules (`counts`, `feeds`,
 * `cursors`, `versions`, `projections`, and `query`). */
export { childRecountStatements } from "./counts";
export {
  getFeedPruneCursor,
  pruneActorFeed,
  pruneFeedItems,
  pruneGrownFeeds,
  saveFeedPruneCursor,
  sweepFeedItems,
  type FeedSweepResult,
  type GrownFeedPruneResult,
} from "./feeds";
export {
  JETSTREAM_V2_SERVICE_META_KEY,
  assertJetstreamServiceCompatibility,
  assertServingSourceCompatibility,
  getLastCursor,
  getServingSourcePosition,
  loadKnownActorDids,
  lookupKnownActorDids,
  orderedSourcePosition,
  saveCursor,
  saveCursorStatement,
  saveJetstreamCursor,
  saveJetstreamCursorStatement,
  saveOrderedSourcePositionStatement,
  saveServingSourcePositionStatement,
  type ServingSourcePosition,
} from "./cursors";
export {
  compareRecordVersions,
  isProjectionConflictError,
  lookupExistingRecords,
  lookupRecordVersions,
  selectAuthoritativeMutations,
  selectCurrentMutations,
  selectMutationWinners,
  type ExistingRecordInfo,
  type MutationSelection,
  type RecordVersionInfo,
} from "./versions";
export {
  projectEvents,
  rebuildDerivedProjections,
  type DerivedProjectionProgress,
  type DerivedProjectionResumeCursor,
  type RebuildDerivedProjectionsOptions,
} from "./projections";
export { queryRecords, type QueryOptions, type SortOption } from "./query";
