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
  it('sends the file locator of each built-in file tool', () => {
    expect(outboundInput('Read', { file_path: '/repo/a.ts', offset: 10 })).toEqual({
      file_path: '/repo/a.ts',
      offset: '<number>',
    });
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      expect(outboundInput(tool, { file_path: '/repo/a.ts' }).file_path).toBe('/repo/a.ts');
    }
    expect(outboundInput('NotebookEdit', { notebook_path: '/repo/nb.ipynb' }).notebook_path).toBe(
      '/repo/nb.ipynb',
    );
  });

  it('keeps field names but replaces every other value with a size marker', () => {
    const prompt = 'do the thing';
    const out = outboundInput('mcp__whatever__tool', {
      prompt,
      count: 42,
      enabled: true,
      tags: ['a', 'b', 'c'],
      meta: { nested: 'value' },
    });
    expect(out).toEqual({
      prompt: `<${prompt.length} chars>`,
      count: '<number>',
      enabled: '<boolean>',
      tags: '<array>',
      meta: '<object>',
    });
  });

  it('sends no part of a Bash command, including a leading assignment', () => {
    const command = 'PASSWORD=hunter2 ./run --deploy';
    const out = outboundInput('Bash', { command, description: 'deploy with PASSWORD=hunter2' });
    expect(out).toEqual({ command: `<${command.length} chars>`, description: '<28 chars>' });
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });

  it('sends no value for a locator-named field outside the built-in pairs', () => {
    const out = outboundInput('mcp__github__create_or_update_file', {
      path: 'ghp_supersecrettoken1234567890',
      description: 'PASSWORD=hunter2',
      pattern: 'hunter2',
      url: 'https://hooks.example.com/services/T0/B0/secret',
    });
    const sent = JSON.stringify(out);
    expect(sent).not.toContain('ghp_');
    expect(sent).not.toContain('hunter2');
    expect(sent).not.toContain('secret');
    expect(outboundInput('Grep', { pattern: 'hunter2', path: '/repo' })).toEqual({
      pattern: '<7 chars>',
      path: '<5 chars>',
    });
  });

  it('sends a size marker for a non-string value in a kept field', () => {
    expect(outboundInput('Read', { file_path: { p: 'hunter2' } })).toEqual({ file_path: '<object>' });
  });

  it('keeps every field name, including __proto__', () => {
    const input = JSON.parse('{"__proto__": "x", "a": 1}') as Record<string, unknown>;
    const out = outboundInput('mcp__x__y', input);
    expect(Object.keys(out)).toEqual(['__proto__', 'a']);
    expect(JSON.stringify(out)).toBe('{"__proto__":"<1 chars>","a":"<number>"}');
  });

  it('does not treat an inherited property name as a tool', () => {
    expect(outboundInput('toString', { file_path: 'hunter2' })).toEqual({ file_path: '<7 chars>' });
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
