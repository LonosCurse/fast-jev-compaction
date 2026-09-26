/**
 * Secret redaction for what leaves the machine. The Jev request carries the
 * history's texts and tool inputs; anything shaped like a credential in them is
 * replaced before the request is built. The transcript itself is never changed.
 *
 * This is a scanner, not one big regex: a small regex locates a credential-named
 * key followed by a separator (`=`, `:`, `": "`, or whitespace after a `--flag`),
 * then a manual character walk consumes the *whole* value — honouring quote
 * escapes with no length cap, or running to the next natural stop character for
 * an unquoted value — and replaces exactly that span with one `[REDACTED]`
 * marker. Four more narrow, explicit rules run alongside it: shaped bare tokens
 * (`sk-`, `ghp_`, `AKIA...`, etc.), PEM private-key blocks, URL userinfo
 * passwords, and the caller's own known secret values (matched verbatim,
 * wherever they appear). Each rule only touches text its earlier neighbours
 * left alone, so a value is never counted or bracketed twice.
 *
 * Pattern-based by necessity: `$.env.get` takes literal names only, so the hook
 * cannot enumerate the environment. Values the hook does hold (its own API key)
 * are passed as `known` and replaced exactly.
 *
 * Best-effort, not a guarantee: a credential with an unrecognised name or shape,
 * split across values, or reconstructed from adjacent fragments can still slip
 * through. This also runs after the state has already been abridged (`fitState`
 * truncates and omits before `jevAsker`/`JevClient.ask` ever see it) — the code
 * path here only has that abridged text, not the original transcript, so a
 * secret truncated mid-value by abridging may not read as one of these shapes
 * by the time redaction sees it. Redacting the full text before abridging would
 * catch more, but the request-building boundary this module hooks does not
 * have the pre-abridged text available to it.
 */

export const REDACTED = '[REDACTED]';

/** Word segments that make a key name credential-shaped by themselves. */
const CREDENTIAL_WORDS = new Set([
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'apikey',
  'auth',
  'authorization',
  'credential',
  'credentials',
  'cookie',
  'bearer',
]);

/** Segments that make a following `key` segment credential-shaped (`api_key`, `access_key`, ...). */
const KEY_QUALIFIERS = new Set([
  'api',
  'access',
  'private',
  'secret',
  'auth',
  'client',
  'signing',
  'encryption',
]);

const CAMEL_SPLIT = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;

/** Splits an identifier into lowercase word segments on `_ - .` and camelCase boundaries. */
function segments(identifier: string): string[] {
  const out: string[] = [];
  for (const part of identifier.split(/[_.-]+/)) {
    if (!part) continue;
    for (const piece of part.split(CAMEL_SPLIT)) {
      if (piece) out.push(piece.toLowerCase());
    }
  }
  return out;
}

/** True when a key name (however it is written) is a credential name, not just a name that contains one. */
function isCredentialKey(identifier: string): boolean {
  const segs = segments(identifier);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (CREDENTIAL_WORDS.has(s)) return true;
    if (s === 'key' && i > 0 && KEY_QUALIFIERS.has(segs[i - 1]!)) return true;
  }
  // `session` alone is not a credential name; only session_token / sessionId / sessionid forms are.
  for (let i = 0; i + 1 < segs.length; i++) {
    if (segs[i] === 'session' && (segs[i + 1] === 'token' || segs[i + 1] === 'id')) return true;
  }
  return segs.length === 1 && segs[0] === 'sessionid';
}

/**
 * A credential-named key immediately followed by `:`/`=` (optionally quoted,
 * JSON-style), or a `--flag` followed by whitespace. The identifier repetition
 * is bounded ({0,63}): an unbounded `[\w.-]*` backtracks quadratically when no
 * `:`/`=` ever follows a long run of identifier-shaped characters (a 100,000-char
 * adversarial run with no separator would otherwise cost one full backtrack per
 * starting position). No real key name is anywhere near 64 characters.
 */
const KEY_SEPARATOR = /"?([A-Za-z][\w.-]{0,63})"?[ \t]*(?::[ \t]*|=[ \t]*)|--([A-Za-z][\w-]{0,63})[ \t]+/g;

const UNQUOTED_STOPS = new Set([' ', '\t', '\n', '\r', ',', ';', '&', '}', ']', ')']);

/**
 * Walks the value starting at `start`: a quoted value runs to its matching
 * unescaped closing quote with no length cap; an unquoted value runs to the
 * next whitespace or `, ; & } ] )` or the end of the text. Either way the walk
 * is a single linear pass, so it cannot backtrack.
 */
function consumeValue(text: string, start: number): { end: number; quote: string | null } {
  const ch = text[start];
  if (ch === '"' || ch === "'") {
    let i = start + 1;
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2;
        continue;
      }
      if (text[i] === ch) {
        i += 1;
        break;
      }
      i += 1;
    }
    return { end: i, quote: ch };
  }
  let i = start;
  while (i < text.length && !UNQUOTED_STOPS.has(text[i]!)) i += 1;
  return { end: i, quote: null };
}

/** `Bearer <token>` / `Basic <token>` right after an `Authorization`/`auth` key: keep the scheme word, redact only the token. */
function schemePrefixLength(text: string, start: number): number {
  const m = /^(?:Bearer|Basic)[ \t]+/i.exec(text.slice(start, start + 16));
  return m ? m[0].length : 0;
}

/** Scans for credential-named `key<sep>value` pairs and redacts each whole value. */
function redactAssignments(text: string): { text: string; count: number } {
  let count = 0;
  let result = '';
  let cursor = 0;
  KEY_SEPARATOR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = KEY_SEPARATOR.exec(text))) {
    const key = m[1] ?? m[2] ?? '';
    let valueStart = KEY_SEPARATOR.lastIndex;
    if (!isCredentialKey(key)) continue;
    const schemeLen = schemePrefixLength(text, valueStart);
    const kept = schemeLen > 0 ? text.slice(valueStart, valueStart + schemeLen) : '';
    valueStart += schemeLen;
    const { end, quote } = consumeValue(text, valueStart);
    if (end === valueStart) continue; // nothing to redact (value is empty or missing)
    result += text.slice(cursor, valueStart - schemeLen) + kept;
    if (quote) {
      const closed = text[end - 1] === quote && end - 1 > valueStart;
      result += quote + REDACTED + (closed ? quote : '');
    } else {
      result += REDACTED;
    }
    count += 1;
    cursor = end;
    KEY_SEPARATOR.lastIndex = end;
  }
  result += text.slice(cursor);
  return { text: result, count };
}

/** Credentials with a recognisable, fully-consumed shape wherever they appear, key or no key. */
const PREFIXED_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]+/g, // Anthropic, OpenAI, OpenRouter
  /\bsk_(?:live|test)_[A-Za-z0-9]+/g, // Stripe
  /\bghp_[A-Za-z0-9]+/g, // GitHub personal access token
  /\bgho_[A-Za-z0-9]+/g, // GitHub OAuth token
  /\bgithub_pat_[A-Za-z0-9_]+/g, // GitHub fine-grained PAT
  /\bxox[bap]-[A-Za-z0-9-]+/g, // Slack bot / app / user token
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
];

const PEM_BEGIN = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/g;
const PEM_END = /-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g;

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

/**
 * `scheme://user:password@host`: keep the user, drop the password, consuming
 * it in full. The scheme repetition is bounded ({0,14}) for the same reason as
 * `KEY_SEPARATOR`: unbounded, it backtracks quadratically over identifier-shaped
 * text that never contains `://`. No real URL scheme is 15 characters long.
 */
const URL_USERINFO = /(\b[a-zA-Z][a-zA-Z0-9+.-]{0,14}:\/\/)([^\s/@:]+):([^\s@]+)@/g;

export type Redaction = { text: string; count: number };

/** Replaces every credential-shaped substring of `text`. */
export function redactSecrets(text: string, known: readonly string[] = []): Redaction {
  let count = 0;
  let out = text;

  const assignments = redactAssignments(out);
  out = assignments.text;
  count += assignments.count;

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

  URL_USERINFO.lastIndex = 0;
  out = out.replace(URL_USERINFO, (_m, scheme: string, user: string) => {
    count += 1;
    return `${scheme}${user}:${REDACTED}@`;
  });

  for (const secret of known) {
    if (!secret) continue;
    const parts = out.split(secret);
    if (parts.length > 1) {
      count += parts.length - 1;
      out = parts.join(REDACTED);
    }
  }

  return { text: out, count };
}

/**
 * Redacts every string inside a JSON-shaped value; returns a new value and the
 * total count. Object keys are never changed, but they are read: a string held
 * under a credential-named key (`{ password: "hunter2" }`), or anywhere inside
 * one (`{ credentials: { user, pass } }`), is replaced whole, since it has no
 * `key=` text around it for the scanner to see.
 *
 * The value is serialized first and the walk runs over the parsed JSON, so it
 * redacts exactly what the request will send. `toJSON` methods, `Date`s,
 * classes and getters are resolved once, up front, by `JSON.stringify` itself;
 * nothing executable survives into the redacted copy to reintroduce a value
 * when the request body is built later.
 */
export function redactDeep<T>(value: T, known: readonly string[] = []): { value: T; count: number } {
  let count = 0;
  const walk = (v: unknown, underCredential: boolean): unknown => {
    if (typeof v === 'string') {
      if (underCredential && v !== '') {
        count += 1;
        return REDACTED;
      }
      const r = redactSecrets(v, known);
      count += r.count;
      return r.text;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, underCredential));
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x, underCredential || isCredentialKey(k));
      return o;
    }
    return v;
  };
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return { value, count };
  return { value: walk(JSON.parse(serialized), false) as T, count };
}
