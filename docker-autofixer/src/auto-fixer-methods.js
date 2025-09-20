const logger = require('./logger');
const { fixDependencyIssues, fixMissingModules } = require('./dependency-fixer');

// Add dependency fixing method to AutoFixer class
async function autoFixerFixDependencyIssues(repoPath, issues) {
  return await fixDependencyIssues.call(this, repoPath, issues);
}

async function autoFixerFixMissingModules(repoPath, missingModules) {
  return await fixMissingModules.call(this, repoPath, missingModules);
}

module.exports = {
  autoFixerFixDependencyIssues,
  autoFixerFixMissingModules,
};
