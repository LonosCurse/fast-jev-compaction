/**
 * Secret redaction for what leaves the machine: a best-effort safety net, not
 * a guarantee (Drew's ruling, 2026-09-26). The transcript itself is never changed.
 *
 * It covers exactly these shapes, and only inside string values (never object keys):
 *   1. prefixed tokens: `sk-`, `sk_live_`/`sk_test_`, `ghp_`, `gho_`, `github_pat_`,
 *      `xox[bap]-`, `AKIA...`;
 *   2. PEM / PGP private-key blocks;
 *   3. the caller's own known secret values, matched verbatim.
 *
 * Each rule matches a token by its own shape; none parses the syntax around it
 * (key=value, JSON, YAML, shell, URLs). Rules that parsed syntax kept drawing
 * new escapes, so they were removed: a plain `PASSWORD=hunter2` is not
 * redacted here. The primary control is sending less to Jev, not redacting more.
 *
 * Redaction runs on the state as `fitState` already abridged it, so a token cut
 * mid-value by abridging may no longer match its shape.
 */

export const REDACTED = '[REDACTED]';

/** Tokens with a recognisable, fully-consumed shape wherever they appear. */
const PREFIXED_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]+/g, // Anthropic, OpenAI, OpenRouter
  /\bsk_(?:live|test)_[A-Za-z0-9]+/g, // Stripe
  /\bghp_[A-Za-z0-9]+/g, // GitHub personal access token
  /\bgho_[A-Za-z0-9]+/g, // GitHub OAuth token
  /\bgithub_pat_[A-Za-z0-9_]+/g, // GitHub fine-grained PAT
  /\bxox[bap]-[A-Za-z0-9-]+/g, // Slack bot / app / user token
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
];

/** Up to four label words (`RSA`, `OPENSSH`, `PGP`, `ENCRYPTED`, ...) and PGP's trailing `BLOCK`; bounded so it stays linear. */
const PEM_BEGIN = /-----BEGIN(?: [A-Z0-9]+){0,4} PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_END = /-----END(?: [A-Z0-9]+){0,4} PRIVATE KEY(?: BLOCK)?-----/g;

/**
 * Replaces each `BEGIN ... END` private-key block. A single forward pass: each
 * search starts where the previous one stopped, and once no END marker remains
 * after a BEGIN, none remains after any later BEGIN either, so the scan stops.
 * (A lazy `[\s\S]*?` regex rescans the whole suffix for every unterminated BEGIN.)
 */
function redactPemBlocks(text: string): { text: string; count: number } {
  let count = 0;
  let result = '';
  let cursor = 0;
  PEM_BEGIN.lastIndex = 0;
  let begin: RegExpExecArray | null;
  while ((begin = PEM_BEGIN.exec(text))) {
    PEM_END.lastIndex = PEM_BEGIN.lastIndex;
    const end = PEM_END.exec(text);
    if (!end) break;
    result += text.slice(cursor, begin.index) + REDACTED;
    count += 1;
    cursor = PEM_END.lastIndex;
    PEM_BEGIN.lastIndex = cursor;
  }
  return { text: result + text.slice(cursor), count };
}

export type Redaction = { text: string; count: number };

/** Replaces every covered token in `text`. */
export function redactSecrets(text: string, known: readonly string[] = []): Redaction {
  let count = 0;
  let out = text;

  // Known values first: a shape rule could otherwise consume only part of one
  // (`sk-v1.rest` → `[REDACTED].rest`), and the exact match would then miss the rest.
  for (const secret of known) {
    if (!secret) continue;
    const parts = out.split(secret);
    if (parts.length > 1) {
      count += parts.length - 1;
      out = parts.join(REDACTED);
    }
  }

  for (const pattern of PREFIXED_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, () => {
      count += 1;
      return REDACTED;
    });
  }

  const pem = redactPemBlocks(out);
  out = pem.text;
  count += pem.count;

  return { text: out, count };
}

/**
 * Redacts every string inside a JSON-shaped value; returns a new value and the
 * total count. Object keys are neither changed nor read.
 *
 * The value is serialized first and the walk runs over the parsed JSON, so it
 * redacts what the request will send. `toJSON` methods, `Date`s, classes and
 * getters are resolved once, up front, by `JSON.stringify` itself; nothing
 * executable survives into the redacted copy to reintroduce a value when the
 * request body is built later.
 */
export function redactDeep<T>(value: T, known: readonly string[] = []): { value: T; count: number } {
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redactSecrets(v, known);
      count += r.count;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      // defineProperty, not `o[k] =`: a JSON key named `__proto__` must stay an own property.
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        Object.defineProperty(o, k, { value: walk(x), enumerable: true, writable: true, configurable: true });
      }
      return o;
    }
    return v;
  };
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return { value, count };
  return { value: walk(JSON.parse(serialized)) as T, count };
}
