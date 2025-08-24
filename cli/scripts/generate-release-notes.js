#!/usr/bin/env node

import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';

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
            console.log(`Tag ${fromTag} not found, using recent commits instead`);
            gitLog = execSync(
                `git log -10 --pretty=format:"%h - %s (%an, %ar)" --no-merges`,
                { encoding: 'utf8' }
            );
        }

        if (!gitLog.trim()) {
            console.log('No commits found for release notes generation');
            return;
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

Do not include any preamble or explanations, just return the markdown release notes.`;

        // Call Claude Code to generate release notes
        console.log('Generating release notes with Claude Code...');
        const releaseNotes = execSync(
            `claude --print "${prompt}"`,
            { 
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'inherit'],
                maxBuffer: 1024 * 1024 * 10 // 10MB buffer
            }
        );

        // Save release notes to a temporary file for release-it to use
        const releaseNotesPath = join(process.cwd(), '.release-notes-temp.md');
        writeFileSync(releaseNotesPath, releaseNotes.trim());
        
        console.log('Release notes generated successfully!');
        console.log('Preview:');
        console.log('='.repeat(50));
        console.log(releaseNotes.trim());
        console.log('='.repeat(50));

    } catch (error) {
        console.error('Error generating release notes:', error.message);
        
        // Fallback: create basic release notes from recent commit messages
        let fallbackCommits;
        try {
            fallbackCommits = execSync(
                `git log -10 --pretty=format:"%h - %s (%an, %ar)" --no-merges`,
                { encoding: 'utf8' }
            );
        } catch (gitError) {
            fallbackCommits = 'No commits found';
        }
        
        const fallbackNotes = `# Release ${toVersion}

## Changes
${fallbackCommits.split('\n').map(line => line.trim() ? `- ${line}` : '').filter(Boolean).join('\n')}
`;
        
        const releaseNotesPath = join(process.cwd(), '.release-notes-temp.md');
        writeFileSync(releaseNotesPath, fallbackNotes);
        
        console.log('Generated fallback release notes');
        process.exit(0); // Don't fail the release process
    }
}

generateReleaseNotes();