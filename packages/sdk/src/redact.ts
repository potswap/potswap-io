// PRD P10.9 — anything that might contain a secret passes through redact() before leaving the process.
const secrets = new Set<string>()

export function registerSecret(s: string) { if (s && s.length >= 16) secrets.add(s) }

export function redact(text: string): string {
  let out = text
  for (const s of secrets) {
    if (out.includes(s)) out = out.split(s).join('[REDACTED]')
    // JSON byte arrays can be re-serialised with different spacing: compare whitespace-free.
    if (s.startsWith('[') && out.replace(/\s+/g, '').includes(s.replace(/\s+/g, ''))) {
      out = out.replace(/\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g, '[REDACTED]')
    }
  }
  return out
}

export function redactValue<T>(v: T): T {
  return JSON.parse(redact(JSON.stringify(v))) as T
}

/** stderr logger (stdout is the MCP transport); always redacted. */
export function log(...parts: unknown[]) {
  process.stderr.write(redact(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')) + '\n')
}
