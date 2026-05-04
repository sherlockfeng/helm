/**
 * Redact sensitive fields from log payloads.
 *
 * Two layers of defense:
 *   1. Field-name allowlist of "definitely sensitive" keys (apiKey, token,
 *      authorization, secret, password) — recursively zeroed out.
 *   2. Pattern detection for likely-secret values: bearer-style tokens,
 *      sk-/api-key prefixes. Replaces the value while keeping a hint for
 *      debuggability ("sk-abc***").
 *
 * Redaction is deep but bounded: depth limit prevents pathological cycles.
 */

const SENSITIVE_KEY_NAMES: ReadonlySet<string> = new Set([
  'apikey', 'api_key', 'authorization', 'token', 'access_token',
  'refresh_token', 'secret', 'password', 'cookie', 'set-cookie',
  'x-api-key', 'lark_app_secret', 'anthropic_api_key',
]);

const TOKEN_PATTERNS: RegExp[] = [
  /^Bearer\s+\S+$/i,
  /^sk-[A-Za-z0-9-_]{8,}$/,
  /^xoxb-[A-Za-z0-9-]{8,}$/,
];

const MAX_DEPTH = 8;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_NAMES.has(key.toLowerCase());
}

function looksLikeSecret(value: string): boolean {
  if (value.length < 12) return false;
  return TOKEN_PATTERNS.some((re) => re.test(value));
}

function maskString(value: string): string {
  if (value.length <= 6) return '***';
  return `${value.slice(0, 4)}***`;
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH || value == null) return value;

  if (typeof value === 'string') {
    return (looksLikeSecret(value) ? maskString(value) : value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1)) as unknown as T;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        out[key] = typeof val === 'string' ? maskString(val) : '***';
      } else {
        out[key] = redact(val, depth + 1);
      }
    }
    return out as T;
  }

  return value;
}
