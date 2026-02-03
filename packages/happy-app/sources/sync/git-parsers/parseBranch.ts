/**
 * Git branch parser
 * Based on simple-git implementation for parsing branch information
 */

import { LineParser } from './LineParser';

export interface BranchSummaryBranch {
    name: string;
    commit: string;
    label: string;
    current: boolean;
}

export interface BranchSummary {
    detached: boolean;
    current: string | null;
    all: string[];
    branches: Record<string, BranchSummaryBranch>;
}

// Regex patterns for different branch formats
const BRANCH_REGEX = /^([*+]\s)?\((.+)\)$/;  // Detached HEAD: * (HEAD detached at abc1234)
const NORMAL_BRANCH_REGEX = /^([*+]\s)?(\S+)(?:\s+([a-f0-9]+)\s+(.*))?$/;  // Normal branch: * main abc1234 commit message

/**
 * Parse git branch output
 */
export function parseBranchSummary(branchOutput: string): BranchSummary {
    const lines = branchOutput.trim().split('\n').filter(line => line.length > 0);
    
    const result: BranchSummary = {
        detached: false,
        current: null,
        all: [],
        branches: {}
    };

    const parser = new LineParser(
        [BRANCH_REGEX, NORMAL_BRANCH_REGEX],
        (target: BranchSummary, matches: (string | undefined)[]) => {
            const isCurrent = !!(matches[1] && matches[1].trim());
            const branchName = matches[2];
            
            if (!branchName) return;

            // Handle detached HEAD state
            if (branchName.startsWith('HEAD detached at') || branchName.startsWith('HEAD detached from')) {
                target.detached = true;
                if (isCurrent) {
                    target.current = branchName;
                }
                return;
            }

            // Handle normal branches
            const commit = matches[3] || '';
            const label = matches[4] || '';

            target.all.push(branchName);
            target.branches[branchName] = {
                name: branchName,
                commit,
                label,
                current: isCurrent
            };

            if (isCurrent) {
                target.current = branchName;
            }
        }
    );

    return parser.parse(result, lines);
}

/**
 * Parse simple branch name from git branch --show-current
 */
export function parseCurrentBranch(branchOutput: string): string | null {
    const trimmed = branchOutput.trim();
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * Get branch status from status character
 */
export function getBranchStatus(statusChar: string): 'current' | 'remote' | 'normal' {
    switch (statusChar?.trim()) {
        case '*':
            return 'current';
        case '+':
            return 'remote';
        default:
            return 'normal';
    }
}