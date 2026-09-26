/**
 * The primary protection against credentials leaving the machine: an
 * ALLOWLIST of tool-input fields whose *value* is ever sent to Jev, not
 * pattern-based redaction. `outboundInput` keeps every field NAME (so Jev
 * still sees the shape of the call) but replaces every value with a size
 * marker (`"<N chars>"`, `"<number>"`, `"<boolean>"`, `"<object>"`,
 * `"<array>"`) unless the field is one of the fixed allowlisted fields below,
 * in which case a string value itself — or, for `url`, a stripped-down
 * scheme+host+pathname — is kept because it identifies *what* the call
 * touched (a file, a search pattern, a subagent) without exposing arguments
 * such as command lines, file contents, or prompts that may carry secrets.
 * For `Bash`-like tools, the first whitespace-delimited word of `command`
 * (the program name) is also kept, with the rest reduced to a size marker.
 */

/** Field names whose value identifies what a call touched, kept verbatim. */
const ALLOWED_FIELDS = new Set([
  'file_path',
  'path',
  'notebook_path',
  'pattern',
  'glob',
  'description',
  'subagent_type',
  'skill',
  'url',
]);

function sizeMarker(value: unknown): string {
  if (typeof value === 'string') return `<${value.length} chars>`;
  if (typeof value === 'number') return '<number>';
  if (typeof value === 'boolean') return '<boolean>';
  if (Array.isArray(value)) return '<array>';
  return '<object>';
}

/** Scheme + host + pathname only; userinfo, query and fragment are dropped. */
function safeUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return sizeMarker(value);
  }
}

function programName(command: string): string {
  const program = /\S+/.exec(command)?.[0] ?? '';
  return `${program} …(${command.length} chars)`;
}

/**
 * Builds the view of one tool call's input that is safe to send to Jev:
 * every field name is kept, but only allowlisted fields keep their value.
 * `Bash`-like tools additionally keep the program name from `command`.
 */
export function outboundInput(
  tool: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'command' && tool === 'Bash') {
      out[key] = typeof value === 'string' ? programName(value) : sizeMarker(value);
      continue;
    }
    if (ALLOWED_FIELDS.has(key)) {
      if (key === 'url') {
        out[key] = typeof value === 'string' ? safeUrl(value) : sizeMarker(value);
      } else {
        out[key] = typeof value === 'string' ? value : sizeMarker(value);
      }
      continue;
    }
    out[key] = sizeMarker(value);
  }
  return out;
}
