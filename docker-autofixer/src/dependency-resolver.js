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
              // Skip built-in Node.js modules
              if (!this.isBuiltInModule(importPath)) {
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

    // Handle template literals and undefined values first
    if (name.includes('${') || name.includes('undefined') || name === 'modulename') {
      return null;
    }

    // Fix common package name issues
    let sanitized = name.trim();

    // Fix scoped package names that lost the @ prefix
    if (sanitized.includes('/') && !sanitized.startsWith('@')) {
      // Handle cases like "expo/metro-config" -> "@expo/metro-config"
      const parts = sanitized.split('/');
      if (parts.length === 2) {
        sanitized = `@${parts[0]}/${parts[1]}`;
      }
    }

    // Remove invalid characters but preserve valid npm package characters
    sanitized = sanitized
      .replace(/[^a-zA-Z0-9\-_.@/]/g, '')
      .replace(/^[._]/, '')
      .replace(/[._]$/, '');

    // Filter out built-in Node.js modules that don't need to be installed
    const builtInModules = ['fs', 'path', 'crypto', 'util', 'child_process', 'http', 'https', 'os', 'stream'];
    if (builtInModules.includes(sanitized)) {
      return null;
    }

    // Check if it's a valid package name
    if (sanitized.length === 0) {
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

  isBuiltInModule(name) {
    const builtInModules = [
      'fs',
      'path',
      'crypto',
      'util',
      'child_process',
      'http',
      'https',
      'os',
      'stream',
      'events',
      'url',
      'querystring',
      'buffer',
      'timers',
      'assert',
      'net',
      'tls',
      'dns',
      'dgram',
      'cluster',
      'readline',
      'repl',
      'vm',
      'constants',
      'zlib',
      'string_decoder',
      'punycode',
    ];
    return builtInModules.includes(name);
  }

  async fixConfigurationIssues(repoPath) {
    try {
      logger.info('Fixing common configuration issues...');

      // Fix ESLint module import issues
      await this.fixESLintConfig(repoPath);

      // Fix TypeScript config issues
      await this.fixTypeScriptConfig(repoPath);

      // Fix package.json module issues
      await this.fixPackageJsonModuleType(repoPath);

      // Fix common dependency conflicts
      await this.fixDependencyConflicts(repoPath);

      // Fix missing configuration files
      await this.fixMissingConfigFiles(repoPath);

      logger.info('Configuration fixes completed');
      return true;
    } catch (error) {
      logger.error(`Configuration fix failed: ${error.message}`);
      return false;
    }
  }

  async fixESLintConfig(repoPath) {
    try {
      const eslintConfigPath = path.join(repoPath, 'eslint.config.js');

      if (await fs.pathExists(eslintConfigPath)) {
        const packageJsonPath = path.join(repoPath, 'package.json');
        const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

        // If using ES modules in eslint.config.js but package.json doesn't specify module type
        if (!packageJson.type) {
          // Create a legacy .eslintrc.js instead
          const eslintContent = await fs.readFile(eslintConfigPath, 'utf8');

          if (eslintContent.includes('import ') && eslintContent.includes('from ')) {
            // Convert to CommonJS format
            const commonjsConfig = `module.exports = {
  root: true,
  env: {
    browser: true,
    es2021: true,
    node: true,
  },
  extends: [
    'eslint:recommended',
    '@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
    'plugin:react-native/all',
    'prettier',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaFeatures: {
      jsx: true,
    },
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: [
    'react',
    'react-hooks',
    'react-native',
    '@typescript-eslint',
    'unused-imports',
    'import',
    'prettier',
  ],
  rules: {
    'prettier/prettier': 'error',
    'react/react-in-jsx-scope': 'off',
    'react/prop-types': 'off',
    '@typescript-eslint/no-unused-vars': 'off',
    'unused-imports/no-unused-imports': 'error',
    'react-native/no-inline-styles': 'off',
    'react-native/no-color-literals': 'off',
  },
  settings: {
    react: {
      version: 'detect',
    },
  },
};`;

            await fs.writeFile(path.join(repoPath, '.eslintrc.js'), commonjsConfig);
            logger.info('Created .eslintrc.js with CommonJS format');
          }
        }
      }
    } catch (error) {
      logger.warn(`ESLint config fix failed: ${error.message}`);
    }
  }

  async fixTypeScriptConfig(repoPath) {
    try {
      const tsConfigPath = path.join(repoPath, 'tsconfig.json');

      if (await fs.pathExists(tsConfigPath)) {
        const tsConfig = JSON.parse(await fs.readFile(tsConfigPath, 'utf8'));

        // Add skipLibCheck for faster compilation
        if (!tsConfig.compilerOptions) {
          tsConfig.compilerOptions = {};
        }

        if (!tsConfig.compilerOptions.skipLibCheck) {
          tsConfig.compilerOptions.skipLibCheck = true;
          logger.info('Added skipLibCheck to TypeScript config');
        }

        // Exclude problematic directories
        if (!tsConfig.exclude) {
          tsConfig.exclude = [];
        }

        const excludeDirs = ['node_modules', 'dist', 'build', '.expo', 'sources/trash'];
        for (const dir of excludeDirs) {
          if (!tsConfig.exclude.includes(dir)) {
            tsConfig.exclude.push(dir);
          }
        }

        await fs.writeFile(tsConfigPath, JSON.stringify(tsConfig, null, 2));
        logger.info('Updated TypeScript configuration');
      }
    } catch (error) {
      logger.warn(`TypeScript config fix failed: ${error.message}`);
    }
  }

  async fixPackageJsonModuleType(repoPath) {
    try {
      const packageJsonPath = path.join(repoPath, 'package.json');
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

      // If no type specified, set to commonjs for compatibility
      if (!packageJson.type) {
        packageJson.type = 'commonjs';
        await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
        logger.info('Set package.json type to commonjs');
      }
    } catch (error) {
      logger.warn(`Package.json module type fix failed: ${error.message}`);
    }
  }

  async fixDependencyConflicts(repoPath) {
    try {
      logger.info('Fixing common dependency conflicts...');

      const packageJsonPath = path.join(repoPath, 'package.json');
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

      if (!packageJson.resolutions) {
        packageJson.resolutions = {};
      }

      let updated = false;

      // Fix common React 19 + legacy package conflicts
      const allDeps = {
        ...(packageJson.dependencies || {}),
        ...(packageJson.devDependencies || {}),
      };

      // Check for React 19 with legacy packages
      const reactVersion = allDeps.react;
      if (reactVersion && reactVersion.includes('19.')) {
        // Force compatible packages for React 19
        if (allDeps['@lottiefiles/dotlottie-react']) {
          packageJson.resolutions['@lottiefiles/dotlottie-react'] = '^0.6.5';
          updated = true;
          logger.info('Added React 19 compatibility resolution for @lottiefiles/dotlottie-react');
        }
      }

      // Fix common ajv version conflicts (very common with ESLint + Expo)
      if (allDeps.eslint && (allDeps.expo || allDeps['expo-router'])) {
        packageJson.resolutions['ajv'] = '^8.11.0';
        packageJson.resolutions['**/ajv'] = '^8.11.0';
        updated = true;
        logger.info('Added ajv version resolution to fix ESLint + Expo conflicts');
      }

      // Fix glob version conflicts
      if (allDeps.eslint || allDeps['@expo/config-plugins']) {
        packageJson.resolutions['glob'] = '>=9.0.0';
        updated = true;
        logger.info('Added glob version resolution');
      }

      // Fix rimraf version conflicts
      if (Object.keys(allDeps).some(dep => dep.includes('expo') || dep.includes('metro'))) {
        packageJson.resolutions['rimraf'] = '>=4.0.0';
        updated = true;
        logger.info('Added rimraf version resolution');
      }

      if (updated) {
        await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
        logger.info('Updated package.json with dependency conflict resolutions');
      }

      return updated;
    } catch (error) {
      logger.warn(`Dependency conflict fix failed: ${error.message}`);
      return false;
    }
  }

  async fixMissingConfigFiles(repoPath) {
    try {
      logger.info('Checking for missing configuration files...');

      // Check for missing google-services.json (common with Expo projects)
      const appConfigPath = path.join(repoPath, 'app.config.js');
      const googleServicesPath = path.join(repoPath, 'google-services.json');

      if ((await fs.pathExists(appConfigPath)) && !(await fs.pathExists(googleServicesPath))) {
        const appConfig = await fs.readFile(appConfigPath, 'utf8');

        if (appConfig.includes('googleServicesFile')) {
          // Create a minimal dummy google-services.json for testing
          const dummyGoogleServices = {
            project_info: {
              project_number: '123456789',
              project_id: 'happy-test',
              storage_bucket: 'happy-test.appspot.com',
            },
            client: [
              {
                client_info: {
                  mobilesdk_app_id: '1:123456789:android:test',
                  android_client_info: {
                    package_name: 'com.slopus.happy.dev',
                  },
                },
                oauth_client: [],
                api_key: [
                  {
                    current_key: 'test-api-key',
                  },
                ],
                services: {
                  appinvite_service: {
                    other_platform_oauth_client: [],
                  },
                },
              },
            ],
            configuration_version: '1',
          };

          await fs.writeFile(googleServicesPath, JSON.stringify(dummyGoogleServices, null, 2));
          logger.info('Created dummy google-services.json for Android prebuild testing');
        }
      }

      return true;
    } catch (error) {
      logger.warn(`Missing config files fix failed: ${error.message}`);
      return false;
    }
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
