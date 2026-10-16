import { describe, expect, it, vi } from 'vitest';
import { register } from '../hooks/fast-jev.ts';
import type { Message } from '../src/index.js';

// `register` is the plugin entry point (`register(on, options)`); nothing above this file
// exercises it. These tests capture the handlers it registers with a fake `on`, then dispatch
// them directly with fake `$`/event/next objects, mocking `$.http.fetch` so no network call is
// made and no real API key is used.

type SessionMessage = Message & { handle?: string };

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool, input, text }],
    handle: `h-${id}`,
  });
}

function result(id: string, text: string, isError = false): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }], handle: `r-${id}` });
}

const fileA = 'export const a = 1;\n'.repeat(50);

function transcript(): SessionMessage[] {
  return [
    message('user', 'Fix the failing test.', { handle: 'h-0' }),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    message('assistant', 'Fixing now.', { handle: 'h-5' }),
  ];
}

function jevFetch(answer: (name: string) => number) {
  return async (_url: string, init?: { body?: string }) => {
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer(key) }]),
    );
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

/** A fake `on` that captures each registered handler by event name, as `register` calls it. */
function harness() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const on = ((pattern: string, hook: (...args: unknown[]) => unknown) => {
    handlers.set(pattern, hook);
  }) as unknown as Parameters<typeof register>[0];
  return { on, handlers };
}

function unreachable(name: string) {
  return vi.fn(async () => {
    throw new Error(`${name} should not be called`);
  });
}

describe('register: session.compact dispatch', () => {
  it('leaves a subagent/fork transcript (agentId set) to core', async () => {
    const { on, handlers } = harness();
    // A key and a real transcript, so a missing guard would reach $.http.fetch
    // instead of failing on the key and falling back to next.
    register(on, { apiKey: 'test-key', minReductionRatio: 0, preserveRecentMessages: 1 });
    const handler = handlers.get('session.compact')!;
    const httpFetch = unreachable('$.http.fetch');
    const next = vi.fn(async (e: unknown) => ({ skip: 'core handled it' }));
    const $ = {
      http: { fetch: httpFetch },
      ui: { log: vi.fn(), toast: vi.fn() },
      env: { get: vi.fn() },
      settings: { read: vi.fn() },
    };
    const event = { trigger: 'auto', agentId: 'sub-1', messages: transcript() };
    const out = await handler($, event, next);
    expect(next).toHaveBeenCalledWith(event);
    expect(out).toEqual({ skip: 'core handled it' });
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('skips a precompute trigger without calling next or asking Jev', async () => {
    const { on, handlers } = harness();
    register(on, {});
    const handler = handlers.get('session.compact')!;
    const httpFetch = unreachable('$.http.fetch');
    const next = vi.fn();
    const $ = {
      http: { fetch: httpFetch },
      ui: { log: vi.fn(), toast: vi.fn() },
      env: { get: vi.fn() },
      settings: { read: vi.fn() },
    };
    const event = { trigger: 'precompute', messages: [] };
    const out = await handler($, event, next);
    expect(out).toEqual({ skip: 'fast-jev-compaction: no precompute' });
    expect(next).not.toHaveBeenCalled();
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('returns compacted messages without handles', async () => {
    const { on, handlers } = harness();
    register(on, { apiKey: 'test-key', minReductionRatio: 0, preserveRecentMessages: 1 });
    const handler = handlers.get('session.compact')!;
    const $ = {
      http: { fetch: jevFetch(() => 0.1) },
      ui: { log: vi.fn(), toast: vi.fn() },
      env: { get: unreachable('$.env.get') },
      settings: { read: unreachable('$.settings.read') },
    };
    const next = vi.fn();
    const event = { trigger: 'auto', messages: transcript() };
    const out = (await handler($, event, next)) as { messages: SessionMessage[] };
    expect(next).not.toHaveBeenCalled();
    expect(out.messages.length).toBeGreaterThan(0);
    for (const m of out.messages) expect('handle' in m).toBe(false);
  });
});

describe('register: turn.complete dispatch', () => {
  const answered = { answer: '', durationMs: 0, isAborted: false, turnId: 't1', reason: 'answer' };

  /** A `$` for turn.complete; `$.session.compact` is unreachable, since it rejects mid-turn. */
  function turn$(percent: number, run: (...args: unknown[]) => Promise<unknown>) {
    const logs: string[] = [];
    const toasts: string[] = [];
    const $ = {
      session: { usage: vi.fn(async () => ({ context: { percent } })), compact: unreachable('$.session.compact') },
      command: { run: vi.fn(run) },
      ui: { log: (t: string) => logs.push(t), toast: (t: string) => toasts.push(t) },
    };
    return { $, logs, toasts };
  }

  it.each([
    { label: 'agentId set (subagent turn)', extra: { agentId: 'sub-1', reason: 'answer' } },
    { label: "reason !== 'answer'", extra: { reason: 'aborted' } },
  ])('bypasses compaction when $label', async ({ extra }) => {
    const { on, handlers } = harness();
    register(on, {});
    const handler = handlers.get('turn.complete')!;
    const usage = unreachable('$.session.usage');
    const run = unreachable('$.command.run');
    const next = vi.fn(async (e: unknown) => e);
    const $ = { session: { usage }, command: { run }, ui: { log: vi.fn(), toast: vi.fn() } };
    const event = { ...answered, ...extra };
    await handler($, event, next);
    expect(usage).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(event);
  });

  it('claims the in-flight guard before awaiting, so an overlapping answered turn bypasses straight to next', async () => {
    const { on, handlers } = harness();
    register(on, { compactAtPercent: 60 });
    const handler = handlers.get('turn.complete')!;
    let resolveUsage!: (value: { context: { percent: number } }) => void;
    const usageGate = new Promise<{ context: { percent: number } }>((res) => {
      resolveUsage = res;
    });
    const usage = vi.fn(() => usageGate);
    const run = vi.fn();
    const $ = { session: { usage }, command: { run }, ui: { log: vi.fn(), toast: vi.fn() } };
    const next1 = vi.fn(async (e: unknown) => 'n1');
    const next2 = vi.fn(async (e: unknown) => 'n2');

    const p1 = handler($, answered, next1);
    // p1's `compacting = true` runs synchronously before its first await, so this second,
    // overlapping dispatch must see the claim and bail out immediately, before p1 resolves.
    const p2 = handler($, answered, next2);
    expect(next2).toHaveBeenCalledWith(answered);
    expect(usage).toHaveBeenCalledTimes(1);

    resolveUsage({ context: { percent: 0 } });
    await Promise.all([p1, p2]);
    expect(usage).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(next1).toHaveBeenCalledWith(answered);
  });

  it('does not compact below compactAtPercent, and queues /compact above it without $.session.compact', async () => {
    const { on, handlers } = harness();
    register(on, { compactAtPercent: 60 });
    const handler = handlers.get('turn.complete')!;
    const next = vi.fn(async (e: unknown) => e);

    const below = turn$(59, async () => ({}));
    await handler(below.$, answered, next);
    expect(below.$.command.run).not.toHaveBeenCalled();

    const above = turn$(75, async () => ({ text: 'Not compacted · user declined' }));
    await handler(above.$, answered, next);
    await vi.waitFor(() => expect(above.logs).toContain('auto-compact: Not compacted · user declined'));
    expect(above.$.command.run).toHaveBeenCalledTimes(1);
    expect(above.$.command.run).toHaveBeenCalledWith({ command: 'compact' });
    expect(above.$.session.compact).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('returns before the queued /compact runs, and holds the guard until it settles', async () => {
    const { on, handlers } = harness();
    register(on, { compactAtPercent: 60 });
    const handler = handlers.get('turn.complete')!;
    let settle!: (value: { text?: string }) => void;
    const { $ } = turn$(75, () => new Promise((res) => (settle = res)));
    const next = vi.fn(async (e: unknown) => e);

    // The queued command waits for an idle session, which can wait on this hook: awaiting it
    // here would deadlock, so the handler must resolve with the command still pending.
    await handler($, answered, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect($.command.run).toHaveBeenCalledTimes(1);

    // While it is pending, a later turn does not queue a second one.
    await handler($, answered, next);
    expect($.session.usage).toHaveBeenCalledTimes(1);
    expect($.command.run).toHaveBeenCalledTimes(1);

    settle({});
    await vi.waitFor(async () => {
      await handler($, answered, next);
      expect($.command.run).toHaveBeenCalledTimes(2);
    });
  });

  it('toasts the first auto-compact failure once and only logs later ones', async () => {
    const { on, handlers } = harness();
    register(on, {});
    const handler = handlers.get('turn.complete')!;
    const logs: string[] = [];
    const toasts: string[] = [];
    const $ = {
      session: {
        usage: async () => {
          throw new Error('boom');
        },
      },
      command: { run: unreachable('$.command.run') },
      ui: { log: (t: string) => logs.push(t), toast: (t: string) => toasts.push(t) },
    };
    const next = vi.fn(async (e: unknown) => e);

    await handler($, answered, next);
    await handler($, answered, next);

    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatch(/auto-compact skipped \(boom\)/);
    expect(logs.filter((l) => l.includes('auto-compact skipped'))).toHaveLength(2);
  });

  it('reports a rejected /compact as skipped and releases the guard', async () => {
    const { on, handlers } = harness();
    register(on, { compactAtPercent: 60 });
    const handler = handlers.get('turn.complete')!;
    const { $, logs, toasts } = turn$(75, async () => {
      throw new Error('unknown command');
    });
    const next = vi.fn(async (e: unknown) => e);

    await handler($, answered, next);
    await vi.waitFor(() => expect(toasts).toEqual(['auto-compact skipped (unknown command)']));
    await vi.waitFor(async () => {
      await handler($, answered, next);
      expect($.command.run).toHaveBeenCalledTimes(2);
    });
    expect(logs.filter((l) => l.includes('auto-compact skipped'))).toHaveLength(2);
  });

  it('releases the guard when $.command.run throws before returning a promise', async () => {
    const { on, handlers } = harness();
    register(on, { compactAtPercent: 60 });
    const handler = handlers.get('turn.complete')!;
    const { $, toasts } = turn$(75, () => {
      throw new Error('command.run unavailable');
    });
    const next = vi.fn(async (e: unknown) => e);

    await handler($, answered, next);
    expect(toasts).toEqual(['auto-compact skipped (command.run unavailable)']);
    await handler($, answered, next);
    expect($.command.run).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenCalledTimes(2);
  });
});
