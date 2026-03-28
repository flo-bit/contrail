const BASE_URL = 'https://ufos-api.microcosm.blue';

export interface MicrocosmRecord<T = unknown> {
	did: string;
	collection: string;
	rkey: string;
	record: T;
	time_us: number;
}

export async function recentRecords<T = unknown>(
	collections: string | string[]
): Promise<MicrocosmRecord<T>[]> {
	const collection = Array.isArray(collections) ? collections.join(',') : collections;
	const url = `${BASE_URL}/records?collection=${encodeURIComponent(collection)}`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Microcosm API error: ${res.status}`);
	return res.json();
}
