/**
 * Secret redaction for anything user-visible (PHASE1-PLAN step 15). Error
 * messages can carry request context, and a transcript is a file that gets
 * pasted into issues — a leaked key must not be one bad error away.
 *
 * Deliberately conservative: it over-masks rather than risk a miss, and it is
 * applied at the boundary where errors become events, never to tool output the
 * model needs to read.
 */
const PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // Anthropic / OpenAI style keys.
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}/g, replacement: 'sk-***redacted***' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replacement: 'gh*_***redacted***' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: 'xox*-***redacted***' },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, replacement: 'Bearer ***redacted***' },
  // key=value / "key": "value" shapes for secret-ish names.
  {
    pattern:
      /\b(api[-_]?key|auth[-_]?token|access[-_]?token|secret|password|credential)\b(["'\s:=]+)([A-Za-z0-9._~+/-]{12,})/gi,
    replacement: '$1$2***redacted***'
  }
];

export function redactSecrets(text: string): string {
  let output = text;
  for (const { pattern, replacement } of PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}
