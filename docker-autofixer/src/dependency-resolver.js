const fs = require('fs-extra');
const path = require('path');
const logger = require('./logger');

class DependencyResolver {
  constructor() {
    this.commonMissingPackages = {
      '@expo/config-plugins': '^8.0.0',
      '@expo/config': '^9.0.0',
      '@expo/metro-config': '^0.18.0',
      '@react-native-community/cli': '^14.0.0',
      '@react-native-community/cli-platform-android': '^14.0.0',
      '@react-native-community/cli-platform-ios': '^14.0.0',
      'expo-modules-core': '~1.12.0',
      'expo-modules-autolinking': '~1.11.0',
      'react-native-screens': '~3.34.0',
      'react-native-safe-area-context': '4.10.5',
      metro: '^0.80.0',
      'metro-resolver': '^0.80.0',
    };
  }

  async detectCompilationIssues(repoPath) {
    const issues = [];

    // Check for missing dependencies
    const missingDeps = await this.detectMissingDependencies(repoPath);
    if (missingDeps.length > 0) {
      issues.push({
        tool: 'dependency',
        type: 'missing_dependencies',
        dependencies: missingDeps,
        severity: 'error',
      });
    }

    // Check for version conflicts
    const versionConflicts = await this.detectVersionConflicts(repoPath);
    if (versionConflicts.length > 0) {
      issues.push({
        tool: 'dependency',
        type: 'version_conflicts',
        conflicts: versionConflicts,
        severity: 'warning',
      });
    }

    // Check for outdated dependencies
    const outdatedDeps = await this.detectOutdatedDependencies(repoPath);
    if (outdatedDeps.length > 0) {
      issues.push({
        tool: 'dependency',
        type: 'outdated_dependencies',
        dependencies: outdatedDeps,
        severity: 'info',
      });
    }

    return issues;
  }

  async detectMissingDependencies(repoPath) {
    const missing = [];

    try {
      // Read package.json
      const packageJsonPath = path.join(repoPath, 'package.json');
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

      const allDeps = {
        ...(packageJson.dependencies || {}),
        ...(packageJson.devDependencies || {}),
      };

      // Check for common missing packages by scanning imports
      const sourceFiles = await this.findSourceFiles(repoPath);

      for (const file of sourceFiles) {
        const content = await fs.readFile(file, 'utf8');
        const imports = this.extractImports(content);

        for (const importPath of imports) {
          if (this.isExternalPackage(importPath) && !allDeps[importPath]) {
            // Check if it's a known missing package
            if (this.commonMissingPackages[importPath]) {
              missing.push({
                package: importPath,
                version: this.commonMissingPackages[importPath],
                foundIn: file,
                type: 'missing',
              });
            } else {
              // Try to infer version for unknown packages
              missing.push({
                package: importPath,
                version: 'latest',
                foundIn: file,
                type: 'missing',
              });
            }
          }
        }
      }

      // Check for Expo-specific missing dependencies
      if (allDeps['expo']) {
        const expoMissing = await this.detectExpoMissingDeps(repoPath, allDeps);
        missing.push(...expoMissing);
      }
    } catch (error) {
      logger.warn(`Error detecting missing dependencies: ${error.message}`);
    }

    return missing;
  }

  async detectExpoMissingDeps(repoPath, existingDeps) {
    const missing = [];
    const expoEssentials = ['@expo/config-plugins', '@expo/config', 'expo-modules-core', 'expo-modules-autolinking'];

    for (const pkg of expoEssentials) {
      if (!existingDeps[pkg]) {
        missing.push({
          package: pkg,
          version: this.commonMissingPackages[pkg] || 'latest',
          foundIn: 'expo configuration',
          type: 'expo_missing',
        });
      }
    }

    return missing;
  }

  async detectVersionConflicts(repoPath) {
    const conflicts = [];

    try {
      // This would involve checking package-lock.json or yarn.lock
      // and detecting version mismatches
      logger.info('Checking for version conflicts...');
    } catch (error) {
      logger.warn(`Error detecting version conflicts: ${error.message}`);
    }

    return conflicts;
  }

  async detectOutdatedDependencies(repoPath) {
    const outdated = [];

    try {
      // This would involve checking npm outdated or similar
      logger.info('Checking for outdated dependencies...');
    } catch (error) {
      logger.warn(`Error detecting outdated dependencies: ${error.message}`);
    }

    return outdated;
  }

  async findSourceFiles(repoPath) {
    const sourceFiles = [];
    const extensions = ['.ts', '.tsx', '.js', '.jsx'];

    async function scanDirectory(dir) {
      const items = await fs.readdir(dir);

      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = await fs.stat(fullPath);

        if (stat.isDirectory() && !item.startsWith('.') && item !== 'node_modules') {
          await scanDirectory(fullPath);
        } else if (stat.isFile() && extensions.some(ext => item.endsWith(ext))) {
          sourceFiles.push(fullPath);
        }
      }
    }

    try {
      await scanDirectory(repoPath);
    } catch (error) {
      logger.warn(`Error scanning source files: ${error.message}`);
    }

    return sourceFiles.slice(0, 100); // Limit to prevent excessive scanning
  }

  extractImports(content) {
    const imports = [];

    // Match ES6 imports
    const es6ImportRegex = /import\s+.*?from\s+['"]([^'"]+)['"]/g;
    let match;

    while ((match = es6ImportRegex.exec(content)) !== null) {
      imports.push(match[1]);
    }

    // Match require statements
    const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

    while ((match = requireRegex.exec(content)) !== null) {
      imports.push(match[1]);
    }

    return imports;
  }

  isExternalPackage(importPath) {
    // External packages don't start with . or /
    return !importPath.startsWith('.') && !importPath.startsWith('/') && !importPath.startsWith('@/');
  }

  async installMissingDependencies(repoPath, missingDeps) {
    logger.info(`Installing ${missingDeps.length} missing dependencies`);

    try {
      // Read current package.json
      const packageJsonPath = path.join(repoPath, 'package.json');
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

      // Add missing dependencies
      if (!packageJson.dependencies) packageJson.dependencies = {};

      const toInstall = [];

      for (const dep of missingDeps) {
        packageJson.dependencies[dep.package] = dep.version;
        toInstall.push(`${dep.package}@${dep.version}`);
        logger.info(`Adding ${dep.package}@${dep.version} to package.json`);
      }

      // Write updated package.json
      await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));

      // Install the packages
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);

      try {
        logger.info('Running yarn install to install new dependencies...');
        await execAsync('yarn install', { cwd: repoPath });
      } catch (yarnError) {
        logger.warn('Yarn install failed, trying npm install...');
        await execAsync('npm install', { cwd: repoPath });
      }

      logger.info('Successfully installed missing dependencies');
      return true;
    } catch (error) {
      logger.error(`Failed to install missing dependencies: ${error.message}`);
      return false;
    }
  }

  parseCompilationError(errorOutput) {
    const issues = [];

    // Parse "Cannot find module" errors
    const moduleNotFoundRegex = /Cannot find module ['"]([^'"]+)['"]/g;
    let match;

    while ((match = moduleNotFoundRegex.exec(errorOutput)) !== null) {
      const moduleName = match[1];
      issues.push({
        tool: 'compilation',
        type: 'missing_module',
        module: moduleName,
        error: match[0],
        severity: 'error',
        fixable: true,
      });
    }

    // Parse TypeScript errors
    const tsErrorRegex = /error TS\d+: (.+)/g;

    while ((match = tsErrorRegex.exec(errorOutput)) !== null) {
      issues.push({
        tool: 'compilation',
        type: 'typescript_error',
        message: match[1],
        error: match[0],
        severity: 'error',
        fixable: false, // Most TS errors need manual fixing
      });
    }

    // Parse Expo config errors
    const expoConfigRegex = /Error reading Expo config.*?Cannot find module ['"]([^'"]+)['"]/s;
    const expoMatch = expoConfigRegex.exec(errorOutput);

    if (expoMatch) {
      issues.push({
        tool: 'compilation',
        type: 'expo_config_error',
        module: expoMatch[1],
        error: expoMatch[0],
        severity: 'error',
        fixable: true,
      });
    }

    return issues;
  }
}

module.exports = DependencyResolver;
