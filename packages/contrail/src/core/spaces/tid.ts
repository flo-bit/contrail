const B32_CHARSET = "234567abcdefghijklmnopqrstuvwxyz";

let lastTimestamp = 0;
let clockId = Math.floor(Math.random() * 1024);

/** Generate an atproto TID: 13-char base32-sortable (timestamp-ordered). */
export function nextTid(): string {
  let now = Date.now() * 1000;
  if (now <= lastTimestamp) now = lastTimestamp + 1;
  lastTimestamp = now;

  const n = BigInt(now) * 1024n + BigInt(clockId);
  let s = "";
  let v = n;
  for (let i = 0; i < 13; i++) {
    s = B32_CHARSET[Number(v & 31n)] + s;
    v >>= 5n;
  }
  return s;
}
