import { describe, expect, it } from 'vitest';

import { jevAsker } from '../hooks/fast-jev.js';
import { JevClient } from '../src/client.js';
import { REDACTED, redactDeep, redactSecrets } from '../src/redact.js';

// Fake credentials, assembled at run time so no credential-shaped literal sits in the repo.
const j = (...parts: string[]) => parts.join('');
const SECRETS = {
  anthropic: j('sk-', 'ant-oat01-', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'),
  openrouter: j('sk-', 'or-v1-', '0123456789abcdef'.repeat(3)),
  stripeLive: j('sk_', 'live_', 'AbCdEfGhIjKlMnOp12'),
  stripeTest: j('sk_', 'test_', 'AbCdEfGhIjKlMnOp12'),
  githubPat: j('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'),
  githubOauth: j('gh', 'o_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'),
  githubFine: j('github_pat_', 'A1b2C3d4E5f6G7h8I9j0_K1l2M3n4O5p6Q7r8'),
  slack: j('xoxb', '-1234567890-1234567890-', 'AbCdEfGhIjKlMnOpQrStUvWx'),
  aws: j('AKIA', 'IOSFODNN7EXAMPLE'),
};

describe('redactSecrets: prefixed and shaped credentials', () => {
  it.each(Object.entries(SECRETS))('removes a %s credential in prose, commands and JSON', (_name, secret) => {
    for (const text of [
      secret,
      `use ${secret} here`,
      `curl -H "Authorization: Bearer ${secret}" https://x`,
      `API_KEY=${secret}`,
      JSON.stringify({ command: `echo ${secret}` }),
    ]) {
      const out = redactSecrets(text);
      expect(out.text).not.toContain(secret);
      expect(out.count).toBeGreaterThan(0);
    }
  });

  it('leaves one marker, counted once, when a prefixed pattern already took the value (no double bracket)', () => {
    const key = SECRETS.anthropic;
    expect(redactSecrets(`API_KEY=${key}`)).toEqual({ text: `API_KEY=${REDACTED}`, count: 1 });
  });
});

describe('redactSecrets: credential-named key + separator + whole-value walk', () => {
  it('keeps the name of an assignment and drops only the value', () => {
    expect(redactSecrets('DB_PASSWORD=hunter2hunter2').text).toBe(`DB_PASSWORD=${REDACTED}`);
    expect(redactSecrets('--token abcdefgh12345678').text).toBe(`--token ${REDACTED}`);
  });

  it('redacts JSON, YAML and CLI forms', () => {
    expect(redactSecrets(JSON.stringify({ api_key: 'sk-abc123secretvalue' })).text).toBe(
      '{"api_key":"[REDACTED]"}',
    );
    expect(redactSecrets('password: x').text).toBe(`password: ${REDACTED}`);
    expect(redactSecrets('--api-key=xyz123').text).toBe(`--api-key=${REDACTED}`);
    expect(redactSecrets('--token xyz123').text).toBe(`--token ${REDACTED}`);
  });

  it('redacts Authorization: Bearer / Basic, keeping the scheme word', () => {
    expect(redactSecrets('Authorization: Bearer abc.def-ghi_123').text).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    expect(redactSecrets('Authorization: Basic dXNlcjpwYXNz').text).toBe(
      `Authorization: Basic ${REDACTED}`,
    );
  });

  it('redacts only the token value in a URL query string, leaving other params alone', () => {
    expect(redactSecrets('GET /callback?token=abc123&x=1').text).toBe(
      `GET /callback?token=${REDACTED}&x=1`,
    );
  });

  it('drops the password from URL userinfo and keeps the user', () => {
    const url = 'https://svcuser:Tr0ub4dorSecretValue1@db.example.com:5432/mydb';
    expect(redactSecrets(`curl ${url}`).text).toBe(
      `curl https://svcuser:${REDACTED}@db.example.com:5432/mydb`,
    );
  });

  it('redacts a PEM private key block wherever it appears', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIBOgIBAAJBAK...FAKEFAKEFAKE...==',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = redactSecrets(`config:\n${pem}\nend`);
    expect(out.text).toBe(`config:\n${REDACTED}\nend`);
    expect(out.count).toBe(1);
  });

  it('replaces known values exactly, whatever their shape', () => {
    expect(redactSecrets('key is plainwordsecret!', ['plainwordsecret!']).text).toBe(`key is ${REDACTED}`);
  });
});

describe('redactSecrets: escapes the old regex approach kept leaking on', () => {
  it('handles a quoted value containing an escaped quote of the same kind', () => {
    expect(redactSecrets('"api_key": "abc\\"def123"').text).toBe('"api_key": "[REDACTED]"');
    expect(redactSecrets("password='it\\'s-secret'").text).toBe(`password='${REDACTED}'`);
  });

  it('redacts a quoted value longer than 512 chars, with no length cap', () => {
    const long = 'x'.repeat(600);
    expect(redactSecrets(`PASSWORD="${long}"`).text).toBe(`PASSWORD="${REDACTED}"`);
  });

  it('redacts short values with no minimum length', () => {
    expect(redactSecrets('PASSWORD=hunter2').text).toBe(`PASSWORD=${REDACTED}`);
    expect(redactSecrets('token: x1').text).toBe(`token: ${REDACTED}`);
    expect(redactSecrets('--password p').text).toBe(`--password ${REDACTED}`);
  });

  it('leaves no tail of the secret behind (whole value consumed, not a partial match)', () => {
    const out = redactSecrets('api_key=abcdefghijklmnopqrstuvwxyz0123456789');
    expect(out.text).toBe(`api_key=${REDACTED}`);
    expect(out.text).not.toMatch(/[a-z0-9]{4,}/);
  });
});

describe('redactSecrets: avoids the over-redaction found before', () => {
  it.each([
    'sortKey = "createdAt"',
    'primaryKey: userIdentifier',
    'monkey: someValue123',
    'src/v2Api/Settings2024Page.tsx',
    'plain key: notASecretName',
  ])('leaves a non-credential name alone: %s', (text) => {
    const out = redactSecrets(text);
    expect(out.text).toBe(text);
    expect(out.count).toBe(0);
  });

  it.each([
    'see project_fast_jev_compaction_review_2026-09-23.md now',
    'session 7ed8c43a-fcaf-4df7-8c30-9d1c74a0afcd',
    'The quick brown fox jumps over the lazy dog, twice a week.',
  ])('leaves non-secrets alone: %s', (text) => {
    const out = redactSecrets(text);
    expect(out.text).toBe(text);
    expect(out.count).toBe(0);
  });
});

describe('redactSecrets: linear time on adversarial input', () => {
  it.each([
    ['snake_case runs (key scanner)', 'a1b2c3d4e5_'],
    ['env-name runs (key scanner)', 'SOME_ENV_NAME_'],
    ['key runs (key scanner)', 'key_'],
    ['dash runs (key scanner)', 'x-'],
    ['sk- like runs (prefixed rule)', 'sk-a'],
    ['colon runs (key scanner)', 'a:b:'],
    ['userinfo-like runs (URL rule)', 'a://u:p@'],
  ])('stays fast on ~100,000 chars of %s', (_label, unit) => {
    const text = unit.repeat(Math.ceil(100_000 / unit.length));
    const started = Date.now();
    redactSecrets(text);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('stays fast on a 100,000-char unterminated quoted value', () => {
    const text = `password="${'a'.repeat(100_000)}`;
    const started = Date.now();
    redactSecrets(text);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('stays fast on repeated PEM BEGIN markers with no matching END', () => {
    const unit = '-----BEGIN X PRIVATE KEY-----a';
    const text = unit.repeat(Math.ceil(100_000 / unit.length));
    const started = Date.now();
    redactSecrets(text);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('stays fast checking many known secrets against a large text', () => {
    const known = Array.from({ length: 50 }, (_, i) => `known-secret-value-${i}`);
    const text = 'x'.repeat(100_000);
    const started = Date.now();
    redactSecrets(text, known);
    expect(Date.now() - started).toBeLessThan(100);
  });
});

describe('redactDeep', () => {
  it('redacts every string inside nested values without mutating the input, and never touches keys', () => {
    const input = { a: [{ api_key: `sk-${'y'.repeat(20)}` }], n: 3, sortKey: 'createdAt' };
    const { value, count } = redactDeep(input);
    expect(JSON.stringify(value)).not.toContain('yyyyyyyyyyyyyyyyyyyy');
    expect(count).toBe(1);
    expect((value as typeof input).sortKey).toBe('createdAt');
    expect((input.a[0] as { api_key: string }).api_key).toContain('sk-');
  });

  it('redacts opaque values held under a credential-named key', () => {
    const input = { password: 'hunter2', apiKey: 'opaque-value', user: 'drew', tokens: 'many' };
    const { value, count } = redactDeep(input);
    expect(value).toEqual({ password: REDACTED, apiKey: REDACTED, user: 'drew', tokens: 'many' });
    expect(count).toBe(2);
  });

  it('redacts every string nested under a credential-named key', () => {
    const { value } = redactDeep({ credentials: { user: 'drew', pass: ['p1', 'p2'] }, id: 't1' });
    expect(value).toEqual({ credentials: { user: REDACTED, pass: [REDACTED, REDACTED] }, id: 't1' });
  });

  it('keeps JSON serialization semantics for non-plain objects', () => {
    const when = new Date('2026-09-26T21:00:00Z');
    class Tagged {
      toJSON() {
        return { tag: 'x', secret_token: 'abc' };
      }
    }
    const input = { createdAt: when, tagged: new Tagged() };
    const { value } = redactDeep(input);
    expect(JSON.parse(JSON.stringify(value))).toEqual({
      createdAt: '2026-09-26T21:00:00.000Z',
      tagged: { tag: 'x', secret_token: REDACTED },
    });
    expect(input.createdAt).toBe(when);
  });
});

describe('redactSecrets: PEM walker', () => {
  it('redacts each of two PEM blocks separately and keeps the text between them', () => {
    const block = (n: string) => `-----BEGIN RSA PRIVATE KEY-----\n${n}\n-----END RSA PRIVATE KEY-----`;
    const { text, count } = redactSecrets(`a ${block('MIIone')} b ${block('MIItwo')} c`);
    expect(text).toBe(`a ${REDACTED} b ${REDACTED} c`);
    expect(count).toBe(2);
  });

  it('leaves an unterminated BEGIN marker alone', () => {
    const text = 'x -----BEGIN PRIVATE KEY-----\nMIIabc';
    expect(redactSecrets(text).text).toBe(text);
  });

  it('stays linear on 1,000,000 chars of unterminated BEGIN markers', () => {
    const unit = '-----BEGIN X PRIVATE KEY-----a';
    const text = unit.repeat(Math.ceil(1_000_000 / unit.length));
    const started = Date.now();
    redactSecrets(text);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('jevAsker', () => {
  it('sends no secret in the request body, keeps the API key in the header only', async () => {
    const ownKey = j('my-own-', 'api-key-123456');
    let sent: { body?: string; headers?: Record<string, string> } = {};
    const asker = jevAsker(
      async (_url, init) => {
        sent = init ?? {};
        return { status: 200, ok: true, text: JSON.stringify({ answers: {} }) };
      },
      ownKey,
      'jev-latest',
    );
    await asker.ask(
      { goal: `deploy with ${SECRETS.openrouter} and ${ownKey}` } as never,
      { call_t1: { type: 'noul', instructions: `input was ${SECRETS.anthropic}` } } as never,
    );
    for (const secret of [SECRETS.openrouter, SECRETS.anthropic, ownKey]) {
      expect(sent.body).not.toContain(secret);
    }
    expect(sent.headers?.authorization).toBe(`Bearer ${ownKey}`);
    expect(() => JSON.parse(sent.body ?? '')).not.toThrow();
  });

  it('reports the redacted count through onRedact', async () => {
    const ownKey = j('my-own-', 'api-key-123456');
    let redacted = 0;
    const asker = jevAsker(
      async () => ({ status: 200, ok: true, text: JSON.stringify({ answers: {} }) }),
      ownKey,
      'jev-latest',
      (count) => {
        redacted += count;
      },
    );
    await asker.ask(
      { goal: `deploy with ${SECRETS.openrouter}` } as never,
      { call_t1: { type: 'noul', instructions: 'no secrets here' } } as never,
    );
    expect(redacted).toBeGreaterThan(0);
  });
});

describe('JevClient', () => {
  it('redacts the library request path too, and keeps its own key in the header only', async () => {
    const ownKey = j('client-', 'api-key-123456');
    let body = '';
    let headers: Record<string, string> = {};
    const client = new JevClient({
      apiKey: ownKey,
      fetch: (async (_url: string, init: { body: string; headers: Record<string, string> }) => {
        body = init.body;
        headers = init.headers;
        return { status: 200, ok: true, text: async () => JSON.stringify({ answers: {} }) };
      }) as never,
    });
    await client.ask(
      { goal: `deploy with ${SECRETS.openrouter} and ${ownKey}` } as never,
      { call_t1: { type: 'noul', instructions: `input was ${SECRETS.anthropic}` } } as never,
    );
    for (const secret of [SECRETS.openrouter, SECRETS.anthropic, ownKey]) expect(body).not.toContain(secret);
    expect(headers.authorization).toBe(`Bearer ${ownKey}`);
  });
});
