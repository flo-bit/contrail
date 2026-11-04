import { randomBytes } from 'node:crypto';

/** Single-process prototype state. Values are never encoded into cookies. */
export class EphemeralStore<T> {
  private readonly values = new Map<string, { value: T; expires: number }>();
  constructor(private readonly ttlMs: number, private readonly now = Date.now) {}
  put(value: T): string {
    for (const [key, entry] of this.values) if (entry.expires <= this.now()) this.values.delete(key);
    if (this.values.size >= 1000) this.values.delete(this.values.keys().next().value!);
    const key = randomBytes(32).toString('base64url');
    this.values.set(key, { value, expires: this.now() + this.ttlMs });
    return key;
  }
  get(key: string | undefined): T | undefined {
    if (!key) return;
    const entry = this.values.get(key);
    if (!entry) return;
    if (entry.expires <= this.now()) { this.values.delete(key); return; }
    return entry.value;
  }
  delete(key: string | undefined) { if (key) this.values.delete(key); }
}

export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  // Preserve only our page paths, never fragments, query strings or secrets.
  return /^\/(?:invite|events)\/[^/?#]+\/[^/?#]+$/.test(value) ? value : '/';
}
