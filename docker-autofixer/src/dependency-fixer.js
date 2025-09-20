const logger = require('./logger');

async function fixDependencyIssues(repoPath, issues) {
  logger.info('Starting dependency issue fixes...');

  // Filter dependency-related issues
  const dependencyIssues = issues.filter(
    issue =>
      issue.tool === 'dependency' ||
      issue.tool === 'compilation' ||
      (issue.type && (issue.type.includes('missing') || issue.type.includes('module')))
  );

  if (dependencyIssues.length === 0) {
    logger.info('No dependency issues found to fix');
    return;
  }

  logger.info(`Found ${dependencyIssues.length} dependency issues to fix`);

  // Group issues by type
  const missingModules = [];
  const missingDependencies = [];
  const configErrors = [];

  for (const issue of dependencyIssues) {
    if (issue.type === 'missing_module' || issue.type === 'expo_config_error') {
      missingModules.push(issue.module || issue.package);
    } else if (issue.type === 'missing_dependencies') {
      missingDependencies.push(...issue.dependencies);
    }
  }

  // Fix missing modules
  if (missingModules.length > 0) {
    await this.fixMissingModules(repoPath, missingModules);
  }

  // Fix missing dependencies
  if (missingDependencies.length > 0) {
    await this.dependencyResolver.installMissingDependencies(repoPath, missingDependencies);
  }

  logger.info('Dependency fixes completed');
}

async function fixMissingModules(repoPath, missingModules) {
  logger.info(`Fixing ${missingModules.length} missing modules`);

  const uniqueModules = [...new Set(missingModules)];
  const modulesToInstall = [];

  for (const moduleName of uniqueModules) {
    const version = this.dependencyResolver.commonMissingPackages[moduleName] || 'latest';
    modulesToInstall.push({
      package: moduleName,
      version: version,
      foundIn: 'compilation error',
      type: 'missing_module',
    });
  }

  if (modulesToInstall.length > 0) {
    await this.dependencyResolver.installMissingDependencies(repoPath, modulesToInstall);
  }
}

module.exports = {
  fixDependencyIssues,
  fixMissingModules,
};
