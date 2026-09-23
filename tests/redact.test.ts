import { describe, expect, it } from 'vitest';

import { jevAsker, withoutHandles } from '../hooks/fast-jev.js';
import { REDACTED, redactDeep, redactSecrets } from '../src/redact.js';

// Fake credentials, assembled at run time so no credential-shaped literal sits in the repo.
const j = (...parts: string[]) => parts.join('');
const SECRETS = {
  anthropic: j('sk-', 'ant-oat01-', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'),
  openrouter: j('sk-', 'or-v1-', '0123456789abcdef'.repeat(3)),
  ghlPit: j('pit', '-1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d'),
  github: j('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'),
  jwt: j('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'),
  prefixed: j('TSAFE', '_', '9F3A77B0C1D2E3F405162738495A6B7C8D9E0F1A2B3C4D5E6F708192A3B4C5D6E7F8091A2B3C4'),
  opaque: j('Zx9Qw8Er7Ty6Ui5', 'Op4As3Df2Gh1Jk0LzXcVbNm'),
};

describe('redactSecrets', () => {
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

  it('keeps the name of an assignment and drops only the value', () => {
    expect(redactSecrets('DB_PASSWORD=hunter2hunter2').text).toBe(`DB_PASSWORD=${REDACTED}`);
    expect(redactSecrets('--token abcdefgh12345678').text).toBe(`--token ${REDACTED}`);
  });

  it('replaces known values exactly, whatever their shape', () => {
    expect(redactSecrets('key is plainwordsecret!', ['plainwordsecret!']).text).toBe(`key is ${REDACTED}`);
  });

  it.each([
    'see project_fast_jev_compaction_review_2026-09-23.md now',
    'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1',
    'session 7ed8c43a-fcaf-4df7-8c30-9d1c74a0afcd',
    'commit e3f262a0000000000000000000000000000000ab',
    'const key = fs.readFileSync(path)',
    'token=$TYPESAFE_API_KEY',
    'C:\\Users\\Sam Bell\\projects\\jev-integration\\compaction-pilot\\fast-jev-compaction',
    'The quick brown fox jumps over the lazy dog, twice a week.',
  ])('leaves non-secrets alone: %s', (text) => {
    const out = redactSecrets(text);
    expect(out.text).toBe(text);
    expect(out.count).toBe(0);
  });

  it('redacts every string inside nested values without mutating the input', () => {
    const input = { a: [{ cmd: `x ${SECRETS.ghlPit}` }], n: 3 };
    const { value, count } = redactDeep(input);
    expect(JSON.stringify(value)).not.toContain(SECRETS.ghlPit);
    expect(count).toBe(1);
    expect(input.a[0]!.cmd).toContain(SECRETS.ghlPit);
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
});

describe('withoutHandles', () => {
  it('drops the engine handle and keeps content and tool pairs', () => {
    const out = withoutHandles([
      { role: 'assistant', text: 'a', toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: {} }], handle: 'h1' },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u1', text: 'r', isError: false }], handle: 'h2' },
    ] as never);
    expect(out.every((m) => !('handle' in m))).toBe(true);
    expect(out[0]!.toolUses[0]!.tool_use_id).toBe('u1');
    expect(out[1]!.toolResults![0]!.tool_use_id).toBe('u1');
  });
});
