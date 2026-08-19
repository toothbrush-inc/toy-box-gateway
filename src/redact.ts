// Scrubs token-shaped substrings from error messages before they reach the
// audit log or gateway stderr. Over-redaction is acceptable; leakage is not.

const REDACTED = "[redacted]";

const PATTERNS: readonly RegExp[] = [
  /ya29\.[\w.-]+/g,
  /1\/\/[0-9A-Za-z_-]{8,}/g,
  /\b(?:sk|pk)_live_[0-9A-Za-z]+/g,
  /\bbearer\s+\S+/gi,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|authorization)\s*[=:]\s*\S+/gi,
  /\b[A-Za-z0-9_-]{32,}\b/g,
];

export function redactErrorMessage(message: string, maxLength = 300): string {
  let out = message;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  if (out.length > maxLength) {
    out = `${out.slice(0, maxLength - 1)}…`;
  }
  return out;
}
