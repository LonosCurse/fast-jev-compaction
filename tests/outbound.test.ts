import { describe, expect, it } from 'vitest';
import { compact, outboundInput, type JevAsker, type Message } from '../src/index.js';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): Message {
  return message('assistant', '', { toolUses: [{ tool_use_id: id, tool, input, text }] });
}

function result(id: string, text: string, isError = false): Message {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }] });
}

describe('outboundInput', () => {
  it('keeps the value of every allowlisted field', () => {
    const input = {
      file_path: '/repo/src/a.ts',
      path: '/repo/src',
      notebook_path: '/repo/nb.ipynb',
      pattern: '*.ts',
      glob: 'src/**/*.ts',
      description: 'Run the test suite',
      subagent_type: 'general-purpose',
      skill: 'code-review',
    };
    expect(outboundInput('Task', input)).toEqual(input);
  });

  it('keeps field names but replaces every non-allowlisted value with a size marker', () => {
    const prompt = 'do the thing';
    const query = 'select * from users';
    const out = outboundInput('mcp__whatever__tool', {
      prompt,
      query,
      count: 42,
      enabled: true,
      tags: ['a', 'b', 'c'],
      meta: { nested: 'value' },
    });
    expect(Object.keys(out)).toEqual(['prompt', 'query', 'count', 'enabled', 'tags', 'meta']);
    expect(out.prompt).toBe(`<${prompt.length} chars>`);
    expect(out.query).toBe(`<${query.length} chars>`);
    expect(out.count).toBe('<number>');
    expect(out.enabled).toBe('<boolean>');
    expect(out.tags).toBe('<array>');
    expect(out.meta).toBe('<object>');
    expect(JSON.stringify(out)).not.toContain(prompt);
    expect(JSON.stringify(out)).not.toContain(query);
  });

  it('reduces a Bash command to the program name plus a size marker', () => {
    const out = outboundInput('Bash', { command: 'PASSWORD=hunter2 ./run --deploy' });
    expect(out.command).toBe(`PASSWORD=hunter2 …(${'PASSWORD=hunter2 ./run --deploy'.length} chars)`);
    expect(String(out.command)).not.toContain('./run');
    expect(String(out.command)).not.toContain('--deploy');
  });

  it('never leaks a secret embedded in a Bash command', () => {
    const secret = 'sk-live-abc123XYZsupersecret';
    const out = outboundInput('Bash', { command: `curl -H "Authorization: Bearer ${secret}" https://x` });
    expect(JSON.stringify(out)).not.toContain(secret);
  });

  it('keeps scheme, host and pathname of a url but drops userinfo, query and fragment', () => {
    const out = outboundInput('WebFetch', {
      url: 'https://user:pass@example.com:8443/a/b?token=shh&x=1#frag',
    });
    expect(out.url).toBe('https://example.com:8443/a/b');
    expect(String(out.url)).not.toContain('user');
    expect(String(out.url)).not.toContain('pass');
    expect(String(out.url)).not.toContain('token');
    expect(String(out.url)).not.toContain('frag');
  });

  it('treats an unparsable url like any other value', () => {
    const out = outboundInput('WebFetch', { url: 'not a url at all' });
    expect(out.url).toBe(`<${'not a url at all'.length} chars>`);
  });

  it('never leaks a secret value from an unknown/MCP tool field', () => {
    const secret = 'ghp_supersecrettoken1234567890';
    const out = outboundInput('mcp__github__create_or_update_file', {
      content: secret,
      path: 'README.md',
    });
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(out.path).toBe('README.md');
  });
});

describe('outbound protection through the real state/compaction pipeline', () => {
  it('never sends an Edit old_string/new_string or a Write content to Jev', async () => {
    const bashSecret = 'AKIA_FAKE_ACCESS_KEY_ID_1234';
    const editSecret = 'db_password=CorrectHorseBatteryStaple';
    const messages = [
      message('user', 'do the migration'),
      call('t1', 'Bash', { command: `echo ${bashSecret} > .env` }, 'ok'),
      result('t1', 'ok'),
      call('t2', 'Edit', { file_path: 'config.py', old_string: 'DEBUG=True', new_string: editSecret }, 'ok'),
      result('t2', 'ok'),
      call('t3', 'Write', { file_path: 'out.txt', content: 'top secret payload' }, 'ok'),
      result('t3', 'ok'),
      message('assistant', 'done'),
      message('user', 'thanks'),
    ];

    const sentStates: unknown[] = [];
    const fakeJev: JevAsker = {
      async ask(state, questions) {
        sentStates.push(state);
        return {
          answers: Object.fromEntries(
            Object.keys(questions).map((key) => [key, { type: 'noul' as const, noul: 0.9 }]),
          ),
        };
      },
    };

    await compact(messages, fakeJev, { preserveRecentMessages: 1 });
    expect(sentStates.length).toBeGreaterThan(0);
    const sent = sentStates.map((state) => JSON.stringify(state)).join('\n');
    expect(sent).not.toContain(bashSecret);
    expect(sent).not.toContain(editSecret);
    expect(sent).not.toContain('top secret payload');
  });
});

describe('outboundInput non-string allowlisted values', () => {
  it('reduces a non-string value in an allowlisted field to a size marker', () => {
    const out = outboundInput('mcp__x__y', {
      description: { note: 'sk-live-secret-in-object' },
      path: ['a', 'hunter2'],
    });
    expect(out).toEqual({ description: '<object>', path: '<array>' });
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(JSON.stringify(out)).not.toContain('sk-live-secret-in-object');
  });
});
