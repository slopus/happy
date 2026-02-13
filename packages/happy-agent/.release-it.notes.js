#!/usr/bin/env node

import { execFileSync, execSync } from "child_process";

/**
 * Generate release notes using Claude Code by analyzing git commits
 * Usage: node .release-it.notes.js <to-version>
 */

/**
 * @returns {string | null}
 */
function getLatestStableTag() {
  const tagsRaw = execSync(`git tag --list "happy-agent-v*" --sort=-v:refname`, {
    encoding: "utf8",
  });

  const tags = tagsRaw
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  // Only accept stable semver tags like happy-agent-v1.2.3 (no prerelease suffix).
  const stableTag = tags.find((t) => /^happy-agent-v\d+\.\d+\.\d+$/.test(t));
  return stableTag ?? null;
}

const [, , toVersion] = process.argv;

if (!toVersion) {
  console.error("Usage: node .release-it.notes.js <to-version>");
  process.exit(1);
}

async function generateReleaseNotes() {
  try {
    const fromTag = getLatestStableTag();
    const commitRange = fromTag ? `${fromTag}..HEAD` : "--all";

    let gitLog;
    try {
      gitLog = execSync(
        `git log ${commitRange} --pretty=format:"%h - %s (%an, %ar)" --no-merges -- packages/happy-agent`,
        { encoding: "utf8" }
      );
    } catch (error) {
      console.error(
        `Tag ${fromTag ?? "(none)"} not found, using recent commits instead`
      );
      gitLog = execSync(
        `git log -10 --pretty=format:"%h - %s (%an, %ar)" --no-merges -- packages/happy-agent`,
        { encoding: "utf8" }
      );
    }

    if (!gitLog.trim()) {
      console.error("No commits found for release notes generation");
      process.exit(1);
    }

    const prompt = `Please analyze these git commits and generate professional release notes for version ${toVersion} of the Happy Agent CLI tool (a remote agent control CLI).

The release should cover commits since the latest stable happy-agent tag (happy-agent-vX.Y.Z): ${
      fromTag ?? "(none)"
    }.

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

    console.error("Generating release notes with Claude Code...");
    const releaseNotes = execFileSync(
      "claude",
      ["--add-dir", ".", "--print", prompt],
      {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "inherit"],
        maxBuffer: 1024 * 1024 * 10,
      }
    );

    console.log(releaseNotes.trim());
  } catch (error) {
    console.error("Error generating release notes:", error.message);
    process.exit(1);
  }
}

generateReleaseNotes();
