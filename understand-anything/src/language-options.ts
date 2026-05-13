export interface PromptLanguageOptions {
  targetLanguage?: string;
  languageDirective?: string;
}

export function addLanguageDirective(
  lines: string[],
  options?: PromptLanguageOptions,
): void {
  const directive = options?.languageDirective?.trim();
  if (!directive) {
    return;
  }
  lines.push("## Output Language");
  lines.push("");
  lines.push(directive);
  lines.push("");
}
