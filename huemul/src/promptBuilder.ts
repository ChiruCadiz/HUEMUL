const MAX_CODE_CONTEXT = 3000;

export interface PromptParts {
  filename: string;
  code: string;
  message: string;
}

export function buildPrompt(parts: PromptParts): string {
  const { filename, code, message } = parts;
  let truncated = code;
  if (code.length > MAX_CODE_CONTEXT) {
    truncated =
      code.slice(0, MAX_CODE_CONTEXT) +
      `\n\n… (truncated, ${code.length} chars total)`;
  }

  return `You are Huemul, a helpful AI coding assistant.

File: ${filename}

Code:
\`\`\`
${truncated}
\`\`\`

User request: ${message}`;
}
