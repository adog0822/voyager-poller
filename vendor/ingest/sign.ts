// HMAC-SHA256 request signing between the Actions poller and the Worker.
// WebCrypto only, so it runs in both. Signature covers timestamp, method, path+query, body.

export const TS_HEADER = "x-voyager-timestamp";
export const SIG_HEADER = "x-voyager-signature";
const MAX_SKEW_MS = 5 * 60 * 1000;

const enc = new TextEncoder();

async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

function canonical(ts: string, method: string, pathAndQuery: string, body: string) {
  return `${ts}.${method.toUpperCase()}.${pathAndQuery}.${body}`;
}

export async function signRequest(
  key: string,
  method: string,
  url: string,
  body = "",
  now = Date.now(),
): Promise<Record<string, string>> {
  const u = new URL(url);
  const ts = String(now);
  return { [TS_HEADER]: ts, [SIG_HEADER]: await hmacHex(key, canonical(ts, method, u.pathname + u.search, body)) };
}

/** Constant-time compare of two hex strings. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyRequest(key: string, request: Request, body: string, now = Date.now()): Promise<boolean> {
  const ts = request.headers.get(TS_HEADER);
  const sig = request.headers.get(SIG_HEADER);
  if (!key || !ts || !sig || !/^\d+$/.test(ts)) return false;
  if (Math.abs(now - Number(ts)) > MAX_SKEW_MS) return false;
  const u = new URL(request.url);
  return safeEqual(sig, await hmacHex(key, canonical(ts, request.method, u.pathname + u.search, body)));
}

/** Stable SHA-256 hex of a string (poller uses it to skip unchanged sources). */
export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
