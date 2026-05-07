/**
 * Redact sensitive fields from log payloads (Phase 29 / §25.4 D3 expansion).
 *
 * Three layers of defense:
 *   1. Field-name allowlist of "definitely sensitive" keys (apiKey, token,
 *      authorization, secret, password, private_key, client_secret, etc.) —
 *      recursively zeroed out.
 *   2. Whole-string pattern detection for likely-secret values: bearer-style
 *      tokens, sk-/api-key prefixes, GitHub/GitLab/Stripe/npm tokens, JWTs,
 *      AWS access keys, URLs with embedded credentials. Replaces the value
 *      while keeping a short hint for debuggability ("sk-a***").
 *   3. Substring scan for the same high-confidence patterns embedded in
 *      arbitrary-length text — covers the case where a user pastes a stack
 *      trace / curl example into a comment field. Each match is replaced
 *      in-place with a 4-char hint + `***`, the rest of the line preserved.
 *
 * Redaction is deep but bounded: depth limit prevents pathological cycles
 * and a per-string length cap keeps work bounded on giant payloads.
 */

const SENSITIVE_KEY_NAMES: ReadonlySet<string> = new Set([
  // Generic credentials
  'apikey', 'api_key', 'authorization', 'token', 'access_token',
  'refresh_token', 'authtoken', 'auth_token', 'id_token',
  'secret', 'password', 'passwd', 'pwd', 'pin', 'otp',
  'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization',
  // SDK / vendor specific
  'private_key', 'privatekey', 'client_secret', 'clientsecret',
  'session_token', 'sessiontoken', 'csrf_token', 'csrftoken',
  'aws_secret_access_key', 'aws_access_key_id',
  'lark_app_secret', 'lark_app_id',
  'anthropic_api_key', 'cursor_api_key', 'openai_api_key', 'github_token',
  // Connection strings often carry creds
  'connection_string', 'connectionstring', 'dsn',
]);

/**
 * Patterns that match a complete string value end-to-end. When a value
 * matches any of these, the whole value gets masked.
 */
const WHOLE_STRING_PATTERNS: RegExp[] = [
  /^Bearer\s+\S+$/i,
  /^Basic\s+[A-Za-z0-9+/=]{12,}$/i,
  /^sk-[A-Za-z0-9-_]{16,}$/,
  /^pk-[A-Za-z0-9-_]{16,}$/,
  /^xox[bpoars]-[A-Za-z0-9-]{10,}$/,
];

/**
 * Patterns that often appear *inside* free-form text (stack traces,
 * curl examples, comments, error messages). Each match gets replaced
 * with a short hint; the surrounding text is preserved so debug context
 * isn't lost. Order matters — more specific patterns first.
 */
const EMBEDDED_PATTERNS: RegExp[] = [
  // PEM-armored private keys — multi-line blocks. Capture the whole block
  // including header/footer so a leak via copy-pasted SSH key gets masked.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
  // JWT (3 dot-separated base64url segments, both header + payload start with `eyJ`)
  /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // GitHub personal access tokens / OAuth / refresh / server / installation
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  // GitLab PAT
  /glpat-[A-Za-z0-9_-]{20,}/g,
  // npm token
  /npm_[A-Za-z0-9]{36,}/g,
  // Stripe live/test keys (sk_/pk_/rk_)
  /(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  // AWS access key id (always 20 chars, AKIA prefix)
  /\bAKIA[A-Z0-9]{16}\b/g,
  // Generic sk-/sk_ prefixed tokens (Anthropic / OpenAI / Cursor)
  /\bsk-[A-Za-z0-9-_]{16,}/g,
  // Slack tokens (xoxb / xoxp / xoxa / xoxr / xoxs / xoxe)
  /\bxox[bpoarse]-[A-Za-z0-9-]{10,}/g,
  // Google OAuth ya29 access tokens
  /\bya29\.[A-Za-z0-9_-]{20,}/g,
  // URL with embedded user:pass (https://, mongodb://, postgres://, mysql://, redis://)
  /\b(?:https?|mongodb|postgres(?:ql)?|mysql|redis|amqp):\/\/[^\s:@/]+:[^\s:@/]+@/gi,
  // Bearer / Basic token mid-string (when not anchored)
  /\bBearer\s+[A-Za-z0-9-_.~+/=]{20,}/g,
];

const MAX_DEPTH = 8;
/** Strings larger than this skip the embedded-pattern scan to keep redact() bounded. */
const MAX_SCAN_LENGTH = 100_000;

function isSensitiveKey(key: string): boolean {
  // Normalize: lowercase + strip non-alphanumeric so 'API-Key' / 'api_key' /
  // 'apiKey' / 'api key' all collapse to 'apikey'. Falls back to the raw
  // lowercase form if the normalized one isn't in the set.
  const lower = key.toLowerCase();
  if (SENSITIVE_KEY_NAMES.has(lower)) return true;
  const stripped = lower.replace(/[^a-z0-9]/g, '');
  return SENSITIVE_KEY_NAMES.has(stripped);
}

function looksLikeSecret(value: string): boolean {
  if (value.length < 12) return false;
  return WHOLE_STRING_PATTERNS.some((re) => re.test(value));
}

function maskString(value: string): string {
  if (value.length <= 6) return '***';
  return `${value.slice(0, 4)}***`;
}

function redactEmbedded(value: string): string {
  if (value.length > MAX_SCAN_LENGTH) return value;
  let out = value;
  for (const pattern of EMBEDDED_PATTERNS) {
    // Reset lastIndex defensively; some callers may share these regex
    // instances across modules.
    pattern.lastIndex = 0;
    out = out.replace(pattern, (match) => maskString(match));
  }
  return out;
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH || value == null) return value;

  if (typeof value === 'string') {
    if (looksLikeSecret(value)) return maskString(value) as unknown as T;
    return redactEmbedded(value) as unknown as T;
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
