import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";

export function getProjectPath(workingDirectory: string) {
    const resolvedPath = resolve(workingDirectory);
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const projectsDir = join(claudeConfigDir, 'projects');

    // First, try the simple algorithm to see if there's an exact match
    const simpleProjectId = resolvedPath.replace(/[^a-zA-Z0-9-]/g, '-');
    const simplePath = join(projectsDir, simpleProjectId);

    if (existsSync(simplePath)) {
        try {
            const stat = statSync(simplePath);
            if (stat.isDirectory()) {
                const files = readdirSync(simplePath);
                if (files.some(f => f.endsWith('.jsonl'))) {
                    // Found exact match with session files
                    return simplePath;
                }
            }
        } catch {
            // Continue to scanning approach
        }
    }

    // If no exact match, scan project directories and check session files
    // to find which one corresponds to this working directory.
    // This handles cases where Claude Code uses a different naming algorithm
    // (e.g., for paths with non-ASCII characters)
    if (existsSync(projectsDir)) {
        try {
            const projectDirs = readdirSync(projectsDir);

            for (const dir of projectDirs) {
                const fullPath = join(projectsDir, dir);
                try {
                    const stat = statSync(fullPath);
                    if (stat.isDirectory()) {
                        // Check if this directory contains session files for our working directory
                        const files = readdirSync(fullPath);
                        const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

                        for (const jsonlFile of jsonlFiles) {
                            try {
                                const content = readFileSync(join(fullPath, jsonlFile), 'utf-8');
                                // Check first few lines for cwd match (session files can be large)
                                const lines = content.split('\n').slice(0, 10);
                                for (const line of lines) {
                                    if (line.includes('"cwd"')) {
                                        try {
                                            const parsed = JSON.parse(line);
                                            if (parsed.cwd === resolvedPath) {
                                                return fullPath;
                                            }
                                        } catch {
                                            // Skip malformed JSON lines
                                            continue;
                                        }
                                    }
                                }
                            } catch {
                                // Skip files we can't read
                                continue;
                            }
                        }
                    }
                } catch {
                    // Skip directories we can't read
                    continue;
                }
            }
        } catch {
            // If we can't read the projects directory, fall back to the old algorithm
        }
    }

    // Fallback: use the original algorithm
    // This will be used if no project directories exist yet
    return join(claudeConfigDir, 'projects', simpleProjectId);
}