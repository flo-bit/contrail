/// <reference lib="dom" />
/** IndexedDB-backed implementation of `WatchCache`. Browser-only.
 *
 *  Single object store keyed by the watch query's `cacheKey` (defaults to
 *  the watch URL). Values are `{records, updatedAt}`. Persists across page
 *  reloads; cleared by the user clearing site data. */

import type { WatchCache, WatchRecord } from "./index.js";

interface StoredEntry {
	records: WatchRecord[];
	updatedAt: number;
}

export interface IndexedDBCacheOptions {
	/** Database name. Default: 'contrail-watch-cache'. Bump this (or delete
	 *  via DevTools) if you need to invalidate all cached watch data. */
	dbName?: string;
	/** Object store name within the DB. Default: 'watches'. */
	storeName?: string;
	/** IDB schema version. Default: 1. Only bump when changing
	 *  storeName / schema. */
	version?: number;
}

export function createIndexedDBCache(
	options: IndexedDBCacheOptions = {}
): WatchCache {
	const dbName = options.dbName ?? "contrail-watch-cache";
	const storeName = options.storeName ?? "watches";
	const version = options.version ?? 1;

	let dbPromise: Promise<IDBDatabase> | null = null;
	const openDb = (): Promise<IDBDatabase> => {
		if (dbPromise) return dbPromise;
		dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
			if (typeof indexedDB === "undefined") {
				reject(new Error("IndexedDB not available in this environment"));
				return;
			}
			const req = indexedDB.open(dbName, version);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(storeName)) {
					db.createObjectStore(storeName);
				}
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
			req.onblocked = () =>
				reject(new Error("IDB open blocked (another tab holds an older version)"));
		});
		return dbPromise;
	};

	return {
		async read(key) {
			try {
				const db = await openDb();
				return await new Promise<WatchRecord[] | null>((resolve, reject) => {
					const tx = db.transaction(storeName, "readonly");
					const store = tx.objectStore(storeName);
					const req = store.get(key);
					req.onsuccess = () => {
						const entry = req.result as StoredEntry | undefined;
						resolve(entry?.records ?? null);
					};
					req.onerror = () => reject(req.error);
				});
			} catch {
				return null;
			}
		},
		async write(key, records) {
			try {
				const db = await openDb();
				await new Promise<void>((resolve, reject) => {
					const tx = db.transaction(storeName, "readwrite");
					const store = tx.objectStore(storeName);
					const entry: StoredEntry = { records, updatedAt: Date.now() };
					store.put(entry, key);
					tx.oncomplete = () => resolve();
					tx.onerror = () => reject(tx.error);
					tx.onabort = () => reject(tx.error ?? new Error("tx aborted"));
				});
			} catch {
				// Intentional: caching is best-effort; swallow.
			}
		},
	};
}
