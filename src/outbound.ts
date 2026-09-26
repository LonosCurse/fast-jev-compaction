/**
 * What of a tool call's input is sent to Jev. Every field NAME is kept, so Jev
 * sees the shape of the call, but a field's VALUE is sent only for the exact
 * (built-in tool, field) pairs in `KEEP_VALUE`, and only when it is a string.
 * Those are the file locators Jev needs to see that one call supersedes another
 * (a Read of a file followed by an Edit of it). Every other value becomes a
 * size marker (`"<N chars>"`, `"<number>"`, `"<boolean>"`, `"<array>"`,
 * `"<object>"`). No value is parsed: no shell tokens, no URLs.
 *
 * This limits what tool inputs send. It does not cover conversation text,
 * which is sent to Jev as written.
 */

/** Exact tool name → the one field whose string value is sent. */
const KEEP_VALUE: Record<string, string> = {
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

function sizeMarker(value: unknown): string {
  if (typeof value === 'string') return `<${value.length} chars>`;
  if (typeof value === 'number') return '<number>';
  if (typeof value === 'boolean') return '<boolean>';
  if (Array.isArray(value)) return '<array>';
  return '<object>';
}

/** The view of one tool call's input that is sent to Jev. */
export function outboundInput(
  tool: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const keep = Object.hasOwn(KEEP_VALUE, tool) ? KEEP_VALUE[tool] : undefined;
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      key === keep && typeof value === 'string' ? value : sizeMarker(value),
    ]),
  );
}
