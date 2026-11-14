/** Classify only commands that exclusively read Skill documents as Skill calls.
 * Unknown shell syntax stays a terminal operation; classification never alters failure state.
 */
export function extractSkillNamesFromCommand(command: string | null): string[] {
    if (!command) return [];
    const normalized = command.replaceAll('\\', '/');
    const wrapper = normalized.trim().match(
        /^(?:(?:[^\s"']*\/)?(?:zsh|bash|sh)|(?:[^\s"']*\/)?(?:powershell(?:\.exe)?|pwsh))\s+(?:-[a-z]*c|-Command)\s+(["'])([\s\S]*)\1$/i,
    );
    const executable = wrapper?.[2] ?? normalized;
    // Do not promote pipelines, substitutions, redirects, or background commands.
    if (/[|<>`$()]/.test(executable) || /(^|[^&])&([^&]|$)/.test(executable)) return [];
    const segments = executable.split(/&&|;|\r?\n/).map(part => part.trim()).filter(Boolean);
    if (!segments.length) return [];
    for (const segment of segments) {
        const tokens: string[] = [];
        const tokenPattern = /\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"']+))/y;
        let offset = 0;
        while (offset < segment.length) {
            tokenPattern.lastIndex = offset;
            const match = tokenPattern.exec(segment);
            if (!match) return [];
            tokens.push(match[1] ?? match[2] ?? match[3]);
            offset = tokenPattern.lastIndex;
        }
        // The shell grammar is deliberately narrow: unsupported wrappers remain terminal.
        const reader = tokens.shift()?.split('/').pop()?.replace(/\.exe$/i, '').toLowerCase();
        if (!reader || !['cat', 'sed', 'head', 'tail', 'less', 'more', 'bat', 'batcat', 'type', 'get-content'].includes(reader)) return [];
        let skillPaths = 0;
        let sedScript = false;
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            if (token.endsWith('/SKILL.md')) { skillPaths++; continue; }
            if (token.startsWith('-')) {
                if (['-n', '--lines', '-c', '--bytes'].includes(token) && ['head', 'tail'].includes(reader)) {
                    if (!/^\d+$/.test(tokens[++i] ?? '')) return [];
                } else if (['-e', '--expression'].includes(token) && reader === 'sed') {
                    if (!/^[\d,$p; +~-]+$/.test(tokens[++i] ?? '')) return [];
                    sedScript = true;
                } else {
                    const allowed = reader === 'sed' ? /^(?:-n|--quiet|--silent|--)$/
                        : reader === 'get-content' ? /^(?:-path|-literalpath|-raw)$/i
                        : ['head', 'tail'].includes(reader) ? /^(?:-\d+|--)$/
                        : ['bat', 'batcat'].includes(reader) ? /^(?:-[np]+|--plain|--paging=never|--style=plain|--)$/
                        : /^(?:-[AbeEnstTuv]+|--)$/;
                    if (!allowed.test(token)) return [];
                }
                continue;
            }
            if (reader === 'sed' && !sedScript && /^[\d,$p; +~-]+$/.test(token)) { sedScript = true; continue; }
            return [];
        }
        if (!skillPaths || (reader === 'sed' && !sedScript)) return [];
    }
    return extractSkillPathNames(command);
}

function extractSkillPathNames(command: string | null): string[] {
    if (!command) {
        return [];
    }

    const names = new Set<string>();
    const normalizedCommand = command.replaceAll('\\', '/');
    const shellWrapper = normalizedCommand.trim().match(
        /^(?:(?:[^\s"']*\/)?(?:zsh|bash|sh)|(?:[^\s"']*\/)?(?:powershell(?:\.exe)?|pwsh))\s+(?:-[a-z]*c|-Command)\s+(["'])([\s\S]*)\1$/i,
    );
    const executableCommand = shellWrapper?.[2] ?? normalizedCommand;
    const segments = executableCommand.split(/&&|\|\||;|\r?\n/);
    for (const segment of segments) {
        // A path mention is not proof that the skill was loaded. Only promote
        // commands whose purpose is to read file content; e.g. `git diff --
        // SKILL.md` must remain an ordinary terminal operation.
        const executedReader = /^(?:(?:command|sudo|env)\s+)*(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+))\s+)*(?:[^\s"']*\/)?(?:cat|sed|head|tail|less|more|bat|batcat|type|Get-Content)(?:\.exe)?(?:\s|$)/i;
        if (!executedReader.test(segment.trim())) {
            continue;
        }

        const pathPattern = /(["'])([^"'\r\n]*\/SKILL\.md)\1|([^\s"'`|&()<>]+\/SKILL\.md)/g;
        for (const match of segment.matchAll(pathPattern)) {
            const rawPath = match[2] ?? match[3];
            const parts = rawPath.split('/').filter(Boolean);
            const skillFileIndex = parts.lastIndexOf('SKILL.md');
            const skillsIndex = parts.lastIndexOf('skills');
            if (skillFileIndex < 1) {
                continue;
            }

            const skillName = parts[skillFileIndex - 1];
            const pluginsIndex = parts.lastIndexOf('plugins', skillFileIndex);
            let pluginName: string | null = null;
            if (pluginsIndex >= 0) {
                const pluginPathEnd = skillsIndex > pluginsIndex && skillsIndex < skillFileIndex
                    ? skillsIndex
                    : skillFileIndex - 1;
                const pluginPath = parts.slice(pluginsIndex + 1, pluginPathEnd);
                if (pluginPath[0] === 'cache') {
                    pluginPath.splice(0, Math.min(2, pluginPath.length));
                }
                if (pluginPath.length > 1 && /^\d+(?:\.\d+)*$/.test(pluginPath.at(-1) ?? '')) {
                    pluginPath.pop();
                }
                pluginName = pluginPath.at(-1) ?? null;
            }
            names.add(pluginName ? `${pluginName}:${skillName}` : skillName);
        }
    }

    return [...names];
}
