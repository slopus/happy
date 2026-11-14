/** Select actionable diagnostics before truncating mixed command output. */
export function summarizeToolFailureOutput(output: string): string | null {
    const lines = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/);
    let fence: string | null = null;
    const diagnostics: string[] = [];
    for (const rawLine of lines) {
        const line = rawLine.trim();
        const marker = line.match(/^(`{3,}|~{3,})/);
        if (marker) {
            if (!fence) fence = marker[1][0];
            else if (marker[1][0] === fence) fence = null;
            continue;
        }
        if (fence) continue;
        // Match terminal diagnostics, not a Skill's prose about error handling.
        if (/^(?:(?:[^\s:]+[\\/])?(?:sed|cat|head|tail|less|more|bat|batcat|ls|rg|find|curl|node|python|python3|zsh|bash|sh|Get-Content)(?:\.exe)?:\s*.+|(?:[\w.]*?(?:error|exception)|fatal)(?:\s+\[[^\]]+\])?:\s*.+)$/i.test(line)) {
            diagnostics.push(line);
        }
    }
    if (diagnostics.length > 0) return diagnostics[diagnostics.length - 1].slice(0, 280);

    const firstLine = lines.find((line) => line.trim().length > 0)?.trim();
    // A Markdown/frontmatter heading describes the successfully read document,
    // not why the enclosing command failed. Let the caller use its exit code.
    if (!firstLine || /^(?:---|\+\+\+|#{1,6}\s|`{3,}|~{3,})/.test(firstLine)) return null;
    return firstLine.slice(0, 280);
}

/** Keep the selected diagnostic visible even when it follows a large stdout dump. */
export function toolFailureDetail(output: string, summary: string): string {
    const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
    const limit = 4000;
    if (text.length <= limit) return text;
    const selectedSummary = isGenericToolFailure(summary) ? summarizeToolFailureOutput(output) ?? summary : summary;
    const diagnosticOffset = selectedSummary ? text.lastIndexOf(selectedSummary) : -1;
    const start = diagnosticOffset + selectedSummary.length > limit - 4 ? Math.max(0, diagnosticOffset - 1000) : 0;
    const prefix = start > 0 ? '...\n' : '';
    const remaining = text.slice(start);
    const available = limit - prefix.length;
    return prefix + (remaining.length <= available
        ? remaining
        : remaining.slice(0, available - 4) + '\n...');
}


export function isGenericToolFailure(summary: string): boolean {
    return /^(?:command (?:exited|failed)(?: with (?:exit )?code)? \d+\.?|(?:the )?tool reported a failure\.?)$/i.test(summary.trim());
}

/** Search every retained output field before using a generic lifecycle error. */
export function selectToolFailure(candidates: unknown[], fallback: string): { summary: string; detail?: string } {
    const texts: string[] = [];
    const seen = new Set<object>();
    const visit = (value: unknown, depth: number): void => {
        if (typeof value === 'string') { if (value.trim()) texts.push(value.trim()); return; }
        if (!value || typeof value !== 'object' || depth > 6 || seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) { value.forEach(item => visit(item, depth + 1)); return; }
        const record = value as Record<string, unknown>;
        for (const key of ['message', 'detail', 'stderr', 'output', 'aggregatedOutput', 'aggregated_output', 'result', 'content', 'text', 'reason', 'error']) visit(record[key], depth + 1);
    };
    candidates.forEach(value => visit(value, 0));
    let selected: { summary: string; output: string; rank: number } | undefined;
    for (const output of texts) {
        const summary = summarizeToolFailureOutput(output);
        if (!summary) continue;
        // Prefixing metadata prevents the plain-first-line fallback, leaving only diagnostics.
        const diagnostic = summarizeToolFailureOutput('---\n' + output);
        const rank = isGenericToolFailure(summary) ? 0 : diagnostic ? 2 : 1;
        if (!selected || rank > selected.rank) selected = { summary, output, rank };
    }
    if (!selected) return { summary: fallback };
    const detail = toolFailureDetail(selected.output, selected.summary);
    return { summary: selected.summary, ...(detail !== selected.summary ? { detail } : {}) };
}
