export function addLanguageDirective(lines, options) {
    const directive = options?.languageDirective?.trim();
    if (!directive) {
        return;
    }
    lines.push("## Output Language");
    lines.push("");
    lines.push(directive);
    lines.push("");
}
//# sourceMappingURL=language-options.js.map