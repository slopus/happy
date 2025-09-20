const logger = require('./logger');
const { searchAndApplyFixes } = require('./search-and-fix');

// Add missing methods to the AutoFixer class
async function searchAndApplyFixesMethod(repoPath, issues) {
  logger.info(`Using Exa Search to find solutions for ${issues.length} issues`);
  await searchAndApplyFixes(repoPath, issues, this.exaSearch);
}

async function runClaudeCodeFixes(repoPath, issues) {
  logger.info(`Using Claude Code to fix ${issues.length} complex issues`);

  try {
    // Group issues by type
    const eslintIssues = issues.filter(i => i.tool === 'eslint');
    const typescriptIssues = issues.filter(i => i.tool === 'typescript');

    // Fix ESLint issues with Claude Code
    if (eslintIssues.length > 0) {
      logger.info(`Fixing ${eslintIssues.length} ESLint issues with Claude Code`);
      await this.claudeCode.fixESLintErrors(repoPath, eslintIssues);
    }

    // Fix TypeScript issues with Claude Code
    if (typescriptIssues.length > 0) {
      logger.info(`Fixing ${typescriptIssues.length} TypeScript issues with Claude Code`);
      await this.claudeCode.fixTypeScriptErrors(repoPath, typescriptIssues);
    }

    // Run performance optimization
    await this.claudeCode.optimizePerformance(repoPath);
  } catch (error) {
    logger.error(`Claude Code fixes failed: ${error.message}`);
  }
}

module.exports = {
  searchAndApplyFixesMethod,
  runClaudeCodeFixes,
};
