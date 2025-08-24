#!/usr/bin/env node

import { execSync } from 'child_process';

/**
 * Generate release notes using Claude Code by analyzing git commits
 * Usage: node scripts/generate-release-notes.js <from-tag> <to-version>
 */

const [,, fromTag, toVersion] = process.argv;

if (!fromTag || !toVersion) {
    console.error('Usage: node scripts/generate-release-notes.js <from-tag> <to-version>');
    process.exit(1);
}

async function generateReleaseNotes() {
    try {
        // Get commit range for the release
        const commitRange = fromTag === 'null' || !fromTag ? '--all' : `${fromTag}..HEAD`;
        
        // Get git log for the commits
        let gitLog;
        try {
            gitLog = execSync(
                `git log ${commitRange} --pretty=format:"%h - %s (%an, %ar)" --no-merges`,
                { encoding: 'utf8' }
            );
        } catch (error) {
            // Fallback to recent commits if tag doesn't exist
            console.error(`Tag ${fromTag} not found, using recent commits instead`);
            gitLog = execSync(
                `git log -10 --pretty=format:"%h - %s (%an, %ar)" --no-merges`,
                { encoding: 'utf8' }
            );
        }

        if (!gitLog.trim()) {
            console.error('No commits found for release notes generation');
            process.exit(1);
        }

        // Create a prompt for Claude to analyze commits and generate release notes
        const prompt = `Please analyze these git commits and generate professional release notes for version ${toVersion} of the Happy CLI tool (a Claude Code session sharing CLI).

Git commits:
${gitLog}

Please format the output as markdown with:
- A brief summary of the release
- Organized sections for:
  - 🚀 New Features
  - 🐛 Bug Fixes  
  - ♻️ Refactoring
  - 🔧 Other Changes
- Use bullet points for each change
- Keep descriptions concise but informative
- Focus on user-facing changes
- New line after each section

Do not include any preamble or explanations, just return the markdown release notes.`;

        // Call Claude Code to generate release notes
        console.error('Generating release notes with Claude Code...');
        const releaseNotes = execSync(
            `claude --print "${prompt}"`,
            { 
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'inherit'],
                maxBuffer: 1024 * 1024 * 10 // 10MB buffer
            }
        );

        // Output release notes to stdout for release-it to use
        console.log(releaseNotes.trim());

    } catch (error) {
        console.error('Error generating release notes:', error.message);
        process.exit(1);
    }
}

generateReleaseNotes();