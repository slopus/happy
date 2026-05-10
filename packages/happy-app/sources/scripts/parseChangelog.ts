#!/usr/bin/env tsx

import * as fs from 'fs';
import * as path from 'path';

interface ChangelogEntry {
    title: string;
    summary: string;
    markdown: string;
}

interface ChangelogData {
    entries: ChangelogEntry[];
    latestTitle: string;
}

function parseChangelog(): ChangelogData {
    const changelogPath = path.join(__dirname, '../../CHANGELOG.md');

    if (!fs.existsSync(changelogPath)) {
        console.warn('CHANGELOG.md not found');
        return { entries: [], latestTitle: '' };
    }

    const content = fs.readFileSync(changelogPath, 'utf-8');
    const entries: ChangelogEntry[] = [];

    // Split on # headers (h1 only)
    const sections = content.split(/^# /gm).filter(s => s.trim());

    for (const section of sections) {
        const newlineIndex = section.indexOf('\n');
        if (newlineIndex === -1) continue;

        const title = section.slice(0, newlineIndex).trim();
        const body = section.slice(newlineIndex + 1).trim();
        if (!body) continue;

        // First non-empty line is the summary, rest is markdown
        const lines = body.split('\n');
        let summary = '';
        let markdownStart = 0;

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (trimmed && !trimmed.startsWith('-')) {
                summary = trimmed;
                markdownStart = i + 1;
                break;
            } else if (trimmed.startsWith('-')) {
                // No summary, starts with bullets
                markdownStart = i;
                break;
            }
        }

        const markdown = lines.slice(markdownStart).join('\n').trim();
        entries.push({ title, summary, markdown });
    }

    const latestTitle = entries.length > 0 ? entries[0].title : '';

    return { entries, latestTitle };
}

function main() {
    console.log('Parsing CHANGELOG.md...');

    const changelogData = parseChangelog();
    const outputPath = path.join(__dirname, '../changelog/changelog.json');

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(changelogData, null, 2));

    console.log(`Parsed ${changelogData.entries.length} entries`);
    console.log(`Latest: ${changelogData.latestTitle}`);
}

if (require.main === module) {
    main();
}

export { parseChangelog };
