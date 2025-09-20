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

    // Version compatibility matrix for intelligent resolution
    this.compatibilityMatrix = {
      expo: {
        '53.0.0': {
          'react-native': '0.76.1',
          react: '18.3.1',
          '@expo/config': '~9.0.0',
          '@expo/metro-config': '~0.18.0',
          metro: '~0.81.0',
        },
        '52.0.0': {
          'react-native': '0.75.0',
          react: '18.2.0',
          '@expo/config': '~9.0.0',
          '@expo/metro-config': '~0.17.0',
          metro: '~0.80.0',
        },
        '51.0.0': {
          'react-native': '0.74.0',
          react: '18.2.0',
          '@expo/config': '~8.5.0',
          '@expo/metro-config': '~0.17.0',
          metro: '~0.80.0',
        },
      },
      'react-native': {
        '0.76.1': {
          react: '18.3.1',
          metro: '~0.81.0',
          'metro-resolver': '~0.81.0',
        },
        '0.75.0': {
          react: '18.2.0',
          metro: '~0.80.0',
          'metro-resolver': '~0.80.0',
        },
        '0.74.0': {
          react: '18.2.0',
          metro: '~0.79.0',
          'metro-resolver': '~0.79.0',
        },
      },
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
      logger.info('Checking for version conflicts...');

      // Read package.json
      const packageJsonPath = path.join(repoPath, 'package.json');
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

      const allDeps = {
        ...(packageJson.dependencies || {}),
        ...(packageJson.devDependencies || {}),
      };

      // Check for package-lock.json conflicts
      const packageLockPath = path.join(repoPath, 'package-lock.json');
      if (await fs.pathExists(packageLockPath)) {
        const packageLock = JSON.parse(await fs.readFile(packageLockPath, 'utf8'));

        // Check for version mismatches between package.json and package-lock.json
        if (packageLock.dependencies) {
          for (const [name, version] of Object.entries(allDeps)) {
            if (packageLock.dependencies[name]) {
              const lockVersion = packageLock.dependencies[name].version;
              const cleanVersion = this.cleanVersion(version);

              if (lockVersion && !this.versionsCompatible(cleanVersion, lockVersion)) {
                conflicts.push({
                  package: name,
                  packageJsonVersion: version,
                  lockVersion: lockVersion,
                  type: 'version_mismatch',
                  severity: 'warning',
                });
              }
            }
          }
        }
      }

      // Check for yarn.lock conflicts
      const yarnLockPath = path.join(repoPath, 'yarn.lock');
      if (await fs.pathExists(yarnLockPath)) {
        // Basic yarn.lock conflict detection
        const yarnLockContent = await fs.readFile(yarnLockPath, 'utf8');

        // Look for duplicate package entries with different versions
        const yarnEntries = this.parseYarnLock(yarnLockContent);
        const packageVersions = {};

        for (const entry of yarnEntries) {
          if (!packageVersions[entry.name]) {
            packageVersions[entry.name] = [];
          }
          packageVersions[entry.name].push(entry.version);
        }

        // Detect packages with multiple versions
        for (const [name, versions] of Object.entries(packageVersions)) {
          const uniqueVersions = [...new Set(versions)];
          if (uniqueVersions.length > 1) {
            conflicts.push({
              package: name,
              versions: uniqueVersions,
              type: 'multiple_versions',
              severity: 'info',
            });
          }
        }
      }

      // Check for peer dependency conflicts
      const peerConflicts = await this.detectPeerDependencyConflicts(repoPath, allDeps);
      conflicts.push(...peerConflicts);
    } catch (error) {
      logger.warn(`Error detecting version conflicts: ${error.message}`);
    }

    return conflicts;
  }

  async detectOutdatedDependencies(repoPath) {
    const outdated = [];

    try {
      logger.info('Checking for outdated dependencies...');

      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);

      // Try npm outdated first
      try {
        const { stdout } = await execAsync('npm outdated --json', {
          cwd: repoPath,
          timeout: 60000,
        });

        if (stdout) {
          const outdatedData = JSON.parse(stdout);

          for (const [name, info] of Object.entries(outdatedData)) {
            outdated.push({
              package: name,
              current: info.current,
              wanted: info.wanted,
              latest: info.latest,
              type: 'outdated',
              severity: this.getOutdatedSeverity(info.current, info.latest),
            });
          }
        }
      } catch (npmError) {
        // If npm outdated fails, try yarn outdated
        try {
          logger.info('npm outdated failed, trying yarn outdated...');
          const { stdout } = await execAsync('yarn outdated --json', {
            cwd: repoPath,
            timeout: 60000,
          });

          if (stdout) {
            const lines = stdout.split('\n').filter(line => line.trim());
            for (const line of lines) {
              try {
                const data = JSON.parse(line);
                if (data.type === 'table' && data.data && data.data.body) {
                  for (const row of data.data.body) {
                    if (row.length >= 4) {
                      const [name, current, wanted, latest] = row;
                      outdated.push({
                        package: name,
                        current: current,
                        wanted: wanted,
                        latest: latest,
                        type: 'outdated',
                        severity: this.getOutdatedSeverity(current, latest),
                      });
                    }
                  }
                }
              } catch (parseError) {
                // Skip invalid JSON lines
              }
            }
          }
        } catch (yarnError) {
          logger.warn(`Both npm and yarn outdated commands failed`);

          // Fallback: Manual check for major outdated packages
          await this.manualOutdatedCheck(repoPath, outdated);
        }
      }
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
      // First, validate and repair package.json
      await this.validateAndRepairPackageJson(repoPath);

      // Read current package.json
      const packageJsonPath = path.join(repoPath, 'package.json');
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

      // Add missing dependencies
      if (!packageJson.dependencies) packageJson.dependencies = {};

      const toInstall = [];
      const validDeps = [];

      for (const dep of missingDeps) {
        const sanitizedPackage = this.sanitizePackageName(dep.package);
        const sanitizedVersion = this.sanitizePackageVersion(dep.version);

        if (sanitizedPackage && sanitizedVersion) {
          packageJson.dependencies[sanitizedPackage] = sanitizedVersion;
          toInstall.push(`${sanitizedPackage}@${sanitizedVersion}`);
          validDeps.push(dep);
          logger.info(`Adding ${sanitizedPackage}@${sanitizedVersion} to package.json`);
        } else {
          logger.warn(`Skipping invalid dependency: ${dep.package}@${dep.version}`);
        }
      }

      // Write updated package.json
      await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));

      // Install the packages with enhanced error handling
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);

      // Clear npm/yarn cache first to avoid corrupted cache issues
      try {
        await execAsync('npm cache clean --force', { cwd: repoPath });
      } catch (cacheError) {
        logger.warn('Cache clean failed, continuing...');
      }

      // Try multiple installation methods
      let installSuccess = false;

      // Method 1: Try yarn install
      try {
        logger.info('Running yarn install to install new dependencies...');
        await execAsync('yarn install --network-timeout 300000', { cwd: repoPath, timeout: 300000 });
        installSuccess = true;
      } catch (yarnError) {
        logger.warn(`Yarn install failed: ${yarnError.message}`);

        // Method 2: Try npm install
        try {
          logger.info('Yarn failed, trying npm install...');
          await execAsync('npm install --timeout=300000', { cwd: repoPath, timeout: 300000 });
          installSuccess = true;
        } catch (npmError) {
          logger.warn(`NPM install failed: ${npmError.message}`);

          // Method 3: Try installing packages individually
          try {
            logger.info('Bulk install failed, trying individual package installation...');
            await this.installPackagesIndividually(repoPath, validDeps);
            installSuccess = true;
          } catch (individualError) {
            logger.error(`Individual package installation failed: ${individualError.message}`);
          }
        }
      }

      if (installSuccess) {
        logger.info('Successfully installed missing dependencies');
        return true;
      } else {
        logger.error('All installation methods failed');
        return false;
      }
    } catch (error) {
      logger.error(`Failed to install missing dependencies: ${error.message}`);
      return false;
    }
  }

  async validateAndRepairPackageJson(repoPath) {
    try {
      const packageJsonPath = path.join(repoPath, 'package.json');
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
      let needsRepair = false;

      // Validate package name
      if (!packageJson.name || typeof packageJson.name !== 'string') {
        packageJson.name = 'autofixer-project';
        needsRepair = true;
        logger.info('Fixed missing or invalid package name');
      }

      // Sanitize package name
      packageJson.name = this.sanitizePackageName(packageJson.name);

      // Validate version
      if (!packageJson.version || typeof packageJson.version !== 'string') {
        packageJson.version = '1.0.0';
        needsRepair = true;
        logger.info('Fixed missing or invalid package version');
      }

      // Validate dependencies object
      if (packageJson.dependencies && typeof packageJson.dependencies !== 'object') {
        packageJson.dependencies = {};
        needsRepair = true;
        logger.info('Fixed invalid dependencies object');
      }

      // Validate devDependencies object
      if (packageJson.devDependencies && typeof packageJson.devDependencies !== 'object') {
        packageJson.devDependencies = {};
        needsRepair = true;
        logger.info('Fixed invalid devDependencies object');
      }

      // Fix common package.json issues
      if (packageJson.dependencies) {
        const fixedDeps = {};
        for (const [name, version] of Object.entries(packageJson.dependencies)) {
          const sanitizedName = this.sanitizePackageName(name);
          const sanitizedVersion = this.sanitizePackageVersion(version);
          if (sanitizedName && sanitizedVersion) {
            fixedDeps[sanitizedName] = sanitizedVersion;
          } else {
            logger.warn(`Removed invalid dependency: ${name}@${version}`);
            needsRepair = true;
          }
        }
        packageJson.dependencies = fixedDeps;
      }

      // Add missing required fields for proper npm operation
      if (!packageJson.type) {
        packageJson.type = 'commonjs';
        needsRepair = true;
      }

      if (needsRepair) {
        await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
        logger.info('Repaired package.json with fixes');
      }

      return true;
    } catch (error) {
      logger.error(`Failed to validate and repair package.json: ${error.message}`);
      return false;
    }
  }

  sanitizePackageName(name) {
    if (!name || typeof name !== 'string') return null;

    // Remove invalid characters and normalize
    const sanitized = name
      .toLowerCase()
      .replace(/[^a-z0-9\-_.@/]/g, '')
      .replace(/^[._]/, '')
      .replace(/[._]$/, '');

    // Check if it's a valid package name
    if (sanitized.length === 0 || sanitized.includes('${') || sanitized.includes('undefined')) {
      return null;
    }

    return sanitized;
  }

  sanitizePackageVersion(version) {
    if (!version || typeof version !== 'string') return null;

    // Remove invalid characters and normalize
    const sanitized = version.replace(/[^0-9.^~\-a-zA-Z]/g, '').replace(/^[._]/, '');

    // Check for template literals or undefined values
    if (sanitized.length === 0 || sanitized.includes('${') || sanitized.includes('undefined')) {
      return 'latest';
    }

    // Ensure it starts with a valid version pattern
    if (!/^[\^~]?\d+/.test(sanitized) && sanitized !== 'latest') {
      return 'latest';
    }

    return sanitized;
  }

  async installPackagesIndividually(repoPath, dependencies) {
    const { exec } = require('child_process');
    const util = require('util');
    const execAsync = util.promisify(exec);

    const successful = [];
    const failed = [];

    for (const dep of dependencies) {
      try {
        const sanitizedPackage = this.sanitizePackageName(dep.package);
        const sanitizedVersion = this.sanitizePackageVersion(dep.version);

        if (!sanitizedPackage || !sanitizedVersion) {
          failed.push(dep);
          continue;
        }

        logger.info(`Installing individual package: ${sanitizedPackage}@${sanitizedVersion}`);

        // Try npm install for individual package
        await execAsync(`npm install ${sanitizedPackage}@${sanitizedVersion} --save --timeout=60000`, {
          cwd: repoPath,
          timeout: 60000,
        });

        successful.push(dep);
        logger.info(`Successfully installed: ${sanitizedPackage}@${sanitizedVersion}`);
      } catch (error) {
        logger.warn(`Failed to install ${dep.package}: ${error.message}`);
        failed.push(dep);
      }
    }

    if (successful.length > 0) {
      logger.info(`Individual installation completed: ${successful.length} successful, ${failed.length} failed`);
      return true;
    } else {
      throw new Error('All individual package installations failed');
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

  // Helper methods for version conflict detection
  cleanVersion(version) {
    if (!version || typeof version !== 'string') return '';
    return version.replace(/^[\^~>=<]/, '');
  }

  versionsCompatible(versionA, versionB) {
    if (!versionA || !versionB) return false;

    // Simple semver compatibility check
    const cleanA = this.cleanVersion(versionA);
    const cleanB = this.cleanVersion(versionB);

    // If versions are exactly the same
    if (cleanA === cleanB) return true;

    // Parse major.minor.patch
    const parseVersion = v => {
      const parts = v.split('.').map(part => parseInt(part) || 0);
      return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0 };
    };

    const a = parseVersion(cleanA);
    const b = parseVersion(cleanB);

    // Major version must match for compatibility
    return a.major === b.major;
  }

  parseYarnLock(content) {
    const entries = [];
    const lines = content.split('\n');
    let currentPackage = null;
    let currentVersion = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Match package entry
      if (line.match(/^[a-zA-Z@]/)) {
        const match = line.match(/^([^@\s]+)(?:@(.+?))?:/);
        if (match) {
          currentPackage = match[1];
        }
      }

      // Match version line
      if (line.includes('version ') && currentPackage) {
        const versionMatch = line.match(/version\s+"([^"]+)"/);
        if (versionMatch) {
          currentVersion = versionMatch[1];
          entries.push({
            name: currentPackage,
            version: currentVersion,
          });
          currentPackage = null;
          currentVersion = null;
        }
      }
    }

    return entries;
  }

  async detectPeerDependencyConflicts(repoPath, allDeps) {
    const conflicts = [];

    try {
      // Check node_modules for peer dependency warnings
      const nodeModulesPath = path.join(repoPath, 'node_modules');
      if (await fs.pathExists(nodeModulesPath)) {
        // This is a simplified implementation
        // In a real scenario, you'd parse each package's package.json peerDependencies
        logger.info('Checking peer dependencies...');
      }
    } catch (error) {
      logger.warn(`Error checking peer dependencies: ${error.message}`);
    }

    return conflicts;
  }

  getOutdatedSeverity(current, latest) {
    if (!current || !latest) return 'info';

    const parseVersion = v => {
      const clean = this.cleanVersion(v);
      const parts = clean.split('.').map(part => parseInt(part) || 0);
      return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0 };
    };

    const curr = parseVersion(current);
    const lat = parseVersion(latest);

    // Major version difference = high severity
    if (lat.major > curr.major) return 'error';

    // Minor version difference = medium severity
    if (lat.minor > curr.minor) return 'warning';

    // Patch version difference = low severity
    if (lat.patch > curr.patch) return 'info';

    return 'info';
  }

  async manualOutdatedCheck(repoPath, outdated) {
    try {
      // Check for critically outdated React Native and Expo packages
      const packageJsonPath = path.join(repoPath, 'package.json');
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

      const criticalPackages = {
        'react-native': '0.75.0',
        expo: '52.0.0',
        react: '18.0.0',
        typescript: '5.0.0',
        '@expo/config': '9.0.0',
      };

      const allDeps = {
        ...(packageJson.dependencies || {}),
        ...(packageJson.devDependencies || {}),
      };

      for (const [pkg, recommendedVersion] of Object.entries(criticalPackages)) {
        if (allDeps[pkg]) {
          const currentVersion = this.cleanVersion(allDeps[pkg]);
          const recommended = this.cleanVersion(recommendedVersion);

          const curr = this.parseSimpleVersion(currentVersion);
          const rec = this.parseSimpleVersion(recommended);

          if (curr.major < rec.major) {
            outdated.push({
              package: pkg,
              current: currentVersion,
              wanted: recommendedVersion,
              latest: recommendedVersion,
              type: 'manually_detected_outdated',
              severity: 'error',
            });
          }
        }
      }
    } catch (error) {
      logger.warn(`Manual outdated check failed: ${error.message}`);
    }
  }

  parseSimpleVersion(version) {
    const parts = version.split('.').map(part => parseInt(part) || 0);
    return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0 };
  }

  // Intelligent version resolution based on ecosystem compatibility
  async resolveCompatibleVersions(repoPath, missingDeps) {
    try {
      logger.info('Resolving compatible versions for missing dependencies...');

      // Read current package.json to understand the ecosystem
      const packageJsonPath = path.join(repoPath, 'package.json');
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

      const allDeps = {
        ...(packageJson.dependencies || {}),
        ...(packageJson.devDependencies || {}),
      };

      // Detect primary framework version
      const expoVersion = this.getVersionFromDeps(allDeps, 'expo');
      const reactNativeVersion = this.getVersionFromDeps(allDeps, 'react-native');
      const reactVersion = this.getVersionFromDeps(allDeps, 'react');

      // Resolve compatible versions for missing dependencies
      const resolvedDeps = [];

      for (const dep of missingDeps) {
        let resolvedVersion = dep.version;

        // Try to find compatible version based on ecosystem
        if (expoVersion && this.compatibilityMatrix.expo[expoVersion]) {
          const compatibleVersion = this.compatibilityMatrix.expo[expoVersion][dep.package];
          if (compatibleVersion) {
            resolvedVersion = compatibleVersion;
            logger.info(`Resolved ${dep.package} to version ${resolvedVersion} for Expo ${expoVersion}`);
          }
        } else if (reactNativeVersion && this.compatibilityMatrix['react-native'][reactNativeVersion]) {
          const compatibleVersion = this.compatibilityMatrix['react-native'][reactNativeVersion][dep.package];
          if (compatibleVersion) {
            resolvedVersion = compatibleVersion;
            logger.info(`Resolved ${dep.package} to version ${resolvedVersion} for React Native ${reactNativeVersion}`);
          }
        }

        // Apply additional version resolution logic
        resolvedVersion = this.applyVersionResolutionRules(dep.package, resolvedVersion, allDeps);

        resolvedDeps.push({
          ...dep,
          version: resolvedVersion,
          originalVersion: dep.version,
          resolutionReason: resolvedVersion !== dep.version ? 'ecosystem_compatibility' : 'default',
        });
      }

      return resolvedDeps;
    } catch (error) {
      logger.warn(`Error resolving compatible versions: ${error.message}`);
      return missingDeps; // Return original if resolution fails
    }
  }

  getVersionFromDeps(allDeps, packageName) {
    const version = allDeps[packageName];
    if (!version) return null;

    const cleanVersion = this.cleanVersion(version);

    // Try to match against known versions in compatibility matrix
    if (this.compatibilityMatrix[packageName]) {
      const availableVersions = Object.keys(this.compatibilityMatrix[packageName]);

      // Find best matching version
      for (const availableVersion of availableVersions.sort().reverse()) {
        if (this.versionsCompatible(cleanVersion, availableVersion)) {
          return availableVersion;
        }
      }
    }

    return cleanVersion;
  }

  applyVersionResolutionRules(packageName, version, existingDeps) {
    // Apply specific version resolution rules

    // Rule 1: Ensure TypeScript version compatibility
    if (packageName === 'typescript' && existingDeps['expo']) {
      const expoVersion = this.getVersionFromDeps(existingDeps, 'expo');
      if (expoVersion && parseFloat(expoVersion) >= 53) {
        return '^5.3.0'; // Expo 53+ needs TypeScript 5.3+
      }
    }

    // Rule 2: Metro versions should match
    if (packageName.startsWith('metro') && existingDeps['metro']) {
      const metroVersion = this.getVersionFromDeps(existingDeps, 'metro');
      if (metroVersion) {
        const majorMinor = metroVersion.substring(0, metroVersion.lastIndexOf('.'));
        if (packageName === 'metro-resolver') {
          return `~${majorMinor}.0`;
        }
      }
    }

    // Rule 3: React Native CLI versions should match
    if (packageName.startsWith('@react-native-community/cli') && existingDeps['@react-native-community/cli']) {
      const cliVersion = this.getVersionFromDeps(existingDeps, '@react-native-community/cli');
      if (cliVersion) {
        return `^${cliVersion}`;
      }
    }

    // Rule 4: Expo config packages should have compatible versions
    if (packageName.startsWith('@expo/') && existingDeps['expo']) {
      const expoVersion = this.getVersionFromDeps(existingDeps, 'expo');
      if (expoVersion) {
        const majorVersion = Math.floor(parseFloat(expoVersion));
        if (majorVersion >= 53) {
          if (packageName === '@expo/config') return '~9.0.0';
          if (packageName === '@expo/metro-config') return '~0.18.0';
          if (packageName === '@expo/config-plugins') return '^8.0.0';
        }
      }
    }

    return version; // Return original version if no rules apply
  }

  // Enhanced missing dependency detection with intelligent resolution
  async detectAndResolveMissingDependencies(repoPath) {
    const missingDeps = await this.detectMissingDependencies(repoPath);
    if (missingDeps.length === 0) return missingDeps;

    // Apply intelligent version resolution
    const resolvedDeps = await this.resolveCompatibleVersions(repoPath, missingDeps);

    logger.info(`Resolved ${resolvedDeps.length} missing dependencies with intelligent version selection`);

    // Log resolution details
    for (const dep of resolvedDeps) {
      if (dep.resolutionReason === 'ecosystem_compatibility') {
        logger.info(`  ${dep.package}: ${dep.originalVersion} → ${dep.version} (${dep.resolutionReason})`);
      }
    }

    return resolvedDeps;
  }
}

module.exports = DependencyResolver;
