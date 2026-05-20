/**
 * Shape-only validation for GitHub Personal Access Tokens.
 *
 * Accepts the four known token prefixes that GitHub issues:
 *   - `ghp_*`         classic PAT
 *   - `github_pat_*`  fine-grained PAT
 *   - `gho_*`         OAuth user-to-server token
 *   - `ghs_*`         server-to-server token
 *
 * This is intentionally not a "valid PAT" check — real validation happens
 * against the GitHub API at use time. The point is to fail loudly on the
 * obviously-wrong shape (OpenAI keys, free-form passwords, etc.) before we
 * encrypt them at rest and hand them to git.
 *
 * Cross-repo reference:
 *   aplus-dev-studio specs/remote-git-clone-per-user-credentials Step 2.2.
 */

const PAT_PREFIX_RE = /^(ghp_|github_pat_|gho_|ghs_)/;
const PAT_MIN_LENGTH = 20;

export function isLikelyGithubPat(token: string): boolean {
    if (typeof token !== 'string') return false;
    if (token.length < PAT_MIN_LENGTH) return false;
    return PAT_PREFIX_RE.test(token);
}
