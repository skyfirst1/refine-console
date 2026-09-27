const SECRET_PATTERNS: RegExp[] = [
  /\bsk-(?:ac-|proj-)?[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}=*/gi,
  /\b(?:OPENAI|ACONTEXT|ANTHROPIC|GEMINI|GOOGLE|AWS)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET)\s*[=:]\s*[^\s,;]+/gi,
];

export interface RedactionResult {
  text: string;
  replacements: number;
}

export function redactText(input: string): RedactionResult {
  let text = input;
  let replacements = 0;

  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, () => {
      replacements += 1;
      return "[REDACTED]";
    });
  }

  return { text, replacements };
}

export function truncateText(input: string, maxChars: number): { text: string; truncated: boolean } {
  if (input.length <= maxChars) return { text: input, truncated: false };
  return {
    text: `${input.slice(0, maxChars)}\n[TRUNCATED ${input.length - maxChars} CHARACTERS]`,
    truncated: true,
  };
}
