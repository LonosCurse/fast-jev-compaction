import { describe, expect, test } from 'vitest';
import {
  resultPeek,
  salvageErrorLines,
  salvageIdentifiers,
  salvagedResultText,
} from '../src/salvage.js';

describe('salvageIdentifiers', () => {
  test('finds a unix file path that appears past the head of the text', () => {
    const text = `${'preamble line\n'.repeat(40)}src/components/Button.tsx\n`;

    expect(salvageIdentifiers(text)).toContain('src/components/Button.tsx');
  });

  test('finds an absolute windows path', () => {
    expect(salvageIdentifiers('opened C:\\repos\\app\\main.ts ok')).toContain(
      'C:\\repos\\app\\main.ts',
    );
  });

  test('finds a url', () => {
    expect(salvageIdentifiers('see https://example.com/a/b?c=1 for details')).toContain(
      'https://example.com/a/b?c=1',
    );
  });

  test('finds a git sha', () => {
    expect(salvageIdentifiers('commit e3f262a9c1b4d5e6f7a8b9c0d1e2f3a4b5c6d7e8')).toContain(
      'e3f262a9c1b4d5e6f7a8b9c0d1e2f3a4b5c6d7e8',
    );
  });

  test('does not repeat an identifier that occurs many times', () => {
    const text = 'src/a.ts\n'.repeat(10);

    expect(salvageIdentifiers(text).filter((s) => s === 'src/a.ts')).toHaveLength(1);
  });

  test('returns nothing for prose that carries no identifiers', () => {
    expect(salvageIdentifiers('the operation completed and everything looks fine')).toEqual(
      [],
    );
  });
});

describe('salvageIdentifiers and secrets', () => {
  test('keeps an env var name', () => {
    expect(salvageIdentifiers('DATABASE_URL=postgres://user:pw@host/db')).toContain(
      'DATABASE_URL',
    );
  });

  test('never keeps the value assigned to an env var', () => {
    const out = salvageIdentifiers('DATABASE_URL=postgres://user:hunter2@host/db').join(' ');

    expect(out).not.toContain('hunter2');
  });

  test('never keeps a secret value that is shaped like a path', () => {
    const out = salvageIdentifiers('API_KEY=sk-or-v1/abcdef/ghijkl').join(' ');

    expect(out).not.toContain('abcdef');
  });

  test('never keeps a secret value that is shaped like a url', () => {
    const out = salvageIdentifiers(
      'WEBHOOK=https://hooks.example.com/tok-9f8e7d6c5b4a',
    ).join(' ');

    expect(out).not.toContain('9f8e7d6c5b4a');
  });
});

describe('salvageErrorLines', () => {
  test('keeps a line reporting an error', () => {
    const text = `${'compiling\n'.repeat(30)}Error: cannot find module 'left-pad'\ndone\n`;

    expect(salvageErrorLines(text)).toContain("Error: cannot find module 'left-pad'");
  });

  test('keeps a non-zero exit code line', () => {
    expect(salvageErrorLines('npm run build\nexit code 127\n')).toContain('exit code 127');
  });

  test('ignores an exit code of zero', () => {
    expect(salvageErrorLines('all good\nexit code 0\n')).toEqual([]);
  });

  test('returns nothing when nothing failed', () => {
    expect(salvageErrorLines('built 12 files in 3s\nall tests passed\n')).toEqual([]);
  });

  test('keeps a bare FAIL line, as test runners emit', () => {
    const line = 'FAIL tests/hook.test.ts > session message mapping';

    expect(salvageErrorLines(`compiling\n${line}\n`)).toContain(line);
  });

  test('does not treat a passing summary as a failure', () => {
    expect(salvageErrorLines('Tests  53 passed (53)\n')).toEqual([]);
  });

  test('redacts a secret assigned inside a failing line', () => {
    const out = salvageErrorLines('Error: auth failed for TOKEN=abc123secretvalue').join(' ');

    expect(out).toContain('TOKEN');
    expect(out).not.toContain('abc123secretvalue');
  });
});

const OPTIONS = { headChars: 150, maxChars: 600 };

const PEEK = { headChars: 40, tailChars: 20 };

describe('resultPeek', () => {
  test('returns a short result whole', () => {
    expect(resultPeek('ok: 3 files changed', false, PEEK)).toBe('ok: 3 files changed');
  });

  test('keeps the head and the tail of a long result', () => {
    const text = `HEAD-MARKER${'x'.repeat(500)}TAIL-MARKER`;

    const peek = resultPeek(text, false, PEEK);

    expect(peek).toContain('HEAD-MARKER');
    expect(peek).toContain('TAIL-MARKER');
  });

  test('stays within the sampling budget', () => {
    const text = 'y'.repeat(5000);

    expect(resultPeek(text, false, PEEK).length).toBeLessThan(200);
  });

  test('favours the tail of a failed result, where the failure is reported', () => {
    // A newline before the error line, as real tool output has: it also
    // gives the boundary-safe cut below a natural place to land.
    const text = `${'z'.repeat(500)}\nError: the real reason`;

    expect(resultPeek(text, true, PEEK)).toContain('Error: the real reason');
  });

  // resultPeek no longer redacts: redaction of everything sent to Jev (state
  // and questions, which carry the peek) is done centrally by a separate
  // scanner PR that wraps the whole request. This peek's own safety net is
  // boundary-aware cutting, not full redaction — see the tests below.

  test('peekTailChars 0 yields a bounded sample with only a head', () => {
    const text = `HEAD-MARKER${' filler'.repeat(200)}TAIL-MARKER`;

    const peek = resultPeek(text, false, { headChars: 40, tailChars: 0 });

    expect(peek).toContain('HEAD-MARKER');
    expect(peek).not.toContain('TAIL-MARKER');
    expect(peek.length).toBeLessThan(200);
  });

  test('peekHeadChars 0 yields a bounded sample with only a tail', () => {
    const text = `HEAD-MARKER${' filler'.repeat(200)}TAIL-MARKER`;

    const peek = resultPeek(text, false, { headChars: 0, tailChars: 40 });

    expect(peek).not.toContain('HEAD-MARKER');
    expect(peek).toContain('TAIL-MARKER');
    expect(peek.length).toBeLessThan(200);
  });

  test('both zero yields no sample of the content at all', () => {
    const text = `HEAD-MARKER${' filler'.repeat(200)}TAIL-MARKER`;

    const peek = resultPeek(text, false, { headChars: 0, tailChars: 0 });

    expect(peek).not.toContain('HEAD-MARKER');
    expect(peek).not.toContain('TAIL-MARKER');
    expect(peek).not.toContain('filler');
  });

  test('cuts the head sample on a whitespace boundary so a token is not split in half', () => {
    const secret = 'SECRETVALUEXXXXXXXXXXXXXXXX';
    const text = `short ${secret} ${'filler '.repeat(50)}`;

    // headChars=12 lands inside `secret` (offset 6 into "short " + the token);
    // an exact-index cut would leak "SECRETV". The boundary-safe cut must
    // back off to the whitespace before the token instead.
    const peek = resultPeek(text, false, { headChars: 12, tailChars: 0 });

    expect(peek).not.toContain('SECRET');
  });

  test('cuts the tail sample on a whitespace boundary so a token is not split in half', () => {
    const secret = 'SECRETVALUEXXXXXXXXXXXXXXXX';
    const text = `${'filler '.repeat(50)}${secret} tail-end`;

    // tailChars is chosen so the exact cut point lands inside `secret`.
    const peek = resultPeek(text, false, { headChars: 0, tailChars: 15 });

    expect(peek).not.toContain('SECRET');
  });
});

describe('salvagedResultText', () => {
  test('leaves a short result exactly as it was', () => {
    const text = 'ok: 3 files changed';

    expect(salvagedResultText(text, false, OPTIONS)).toBe(text);
  });

  test('keeps the head of a long result', () => {
    const text = `START-OF-OUTPUT\n${'filler line\n'.repeat(200)}`;

    expect(salvagedResultText(text, false, OPTIONS)).toContain('START-OF-OUTPUT');
  });

  test('keeps a path that upstream head truncation would have lost', () => {
    const text = `${'filler line\n'.repeat(200)}src/deeply/buried/Thing.tsx\n`;

    expect(salvagedResultText(text, false, OPTIONS)).toContain(
      'src/deeply/buried/Thing.tsx',
    );
  });

  test('keeps an error line from the tail of a failed result', () => {
    const text = `${'filler line\n'.repeat(200)}Error: build failed at step 4\n`;

    expect(salvagedResultText(text, true, OPTIONS)).toContain(
      'Error: build failed at step 4',
    );
  });

  test('marks salvaged content so it is not mistaken for the full result', () => {
    const text = `${'filler line\n'.repeat(200)}src/a.ts\n`;

    expect(salvagedResultText(text, false, OPTIONS)).toMatch(/salvaged/i);
  });

  test('stays within the head and salvage budget', () => {
    const text = Array.from({ length: 500 }, (_, i) => `src/file-${i}.ts`).join('\n');

    expect(salvagedResultText(text, false, OPTIONS).length).toBeLessThan(1200);
  });

  test('never leaks an assigned secret into the salvaged block', () => {
    const text = `${'filler line\n'.repeat(200)}AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENG\n`;

    const out = salvagedResultText(text, false, OPTIONS);

    expect(out).toContain('AWS_SECRET_ACCESS_KEY');
    expect(out).not.toContain('wJalrXUtnFEMIK7MDENG');
  });

  test('does not throw on pathological input', () => {
    const text = '\u0000￿'.repeat(5000);

    expect(() => salvagedResultText(text, false, OPTIONS)).not.toThrow();
  });
});
