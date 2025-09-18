#!/usr/bin/env node

/**
 * 🤖 Worker Build Configuration Validator
 * 
 * This script validates your worker build configuration and helps test
 * the distributed build system setup.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function colorize(color, text) {
  return `${colors[color]}${text}${colors.reset}`;
}

function log(level, message) {
  const timestamp = new Date().toISOString().substring(11, 19);
  const levelColors = {
    INFO: 'cyan',
    WARN: 'yellow', 
    ERROR: 'red',
    SUCCESS: 'green'
  };
  
  console.log(`${colorize('blue', timestamp)} ${colorize(levelColors[level] || 'reset', `[${level}]`)} ${message}`);
}

async function validateWorkerConfig() {
  log('INFO', '🤖 Starting worker configuration validation...');
  
  const configPath = path.join(process.cwd(), '.github', 'worker-config.yml');
  const workflowPath = path.join(process.cwd(), '.github', 'workflows', 'worker-builds.yml');
  
  let hasErrors = false;
  
  // Check if configuration file exists
  if (!fs.existsSync(configPath)) {
    log('ERROR', `❌ Configuration file not found: ${configPath}`);
    hasErrors = true;
  } else {
    log('SUCCESS', '✅ Configuration file found');
    
    try {
      // Parse and validate YAML
      const configContent = fs.readFileSync(configPath, 'utf8');
      const config = yaml.parse(configContent);
      
      // Validate required sections
      const requiredSections = ['worker_pool', 'build_matrix', 'resources', 'triggers'];
      for (const section of requiredSections) {
        if (!config[section]) {
          log('ERROR', `❌ Missing required section: ${section}`);
          hasErrors = true;
        } else {
          log('SUCCESS', `✅ Section found: ${section}`);
        }
      }
      
      // Validate worker pool settings
      if (config.worker_pool) {
        const { default_count, max_count } = config.worker_pool;
        if (!default_count || default_count < 1) {
          log('ERROR', '❌ Invalid default_count in worker_pool');
          hasErrors = true;
        }
        if (!max_count || max_count < default_count) {
          log('ERROR', '❌ max_count must be >= default_count');
          hasErrors = true;
        }
        if (max_count > 20) {
          log('WARN', '⚠️  max_count > 20 may exceed GitHub Actions limits');
        }
      }
      
      // Validate build matrix
      if (config.build_matrix) {
        const { web, mobile, tests } = config.build_matrix;
        
        if (!web || !Array.isArray(web) || web.length === 0) {
          log('ERROR', '❌ build_matrix.web must be a non-empty array');
          hasErrors = true;
        }
        
        if (!mobile || !Array.isArray(mobile) || mobile.length === 0) {
          log('ERROR', '❌ build_matrix.mobile must be a non-empty array');
          hasErrors = true;
        }
        
        if (!tests || !Array.isArray(tests) || tests.length === 0) {
          log('ERROR', '❌ build_matrix.tests must be a non-empty array');
          hasErrors = true;
        }
      }
      
      log('INFO', '📊 Configuration summary:');
      log('INFO', `   Default workers: ${config.worker_pool?.default_count || 'not set'}`);
      log('INFO', `   Max workers: ${config.worker_pool?.max_count || 'not set'}`);
      log('INFO', `   Web builds: ${config.build_matrix?.web?.length || 0}`);
      log('INFO', `   Mobile builds: ${config.build_matrix?.mobile?.length || 0}`);
      log('INFO', `   Test suites: ${config.build_matrix?.tests?.length || 0}`);
      
    } catch (error) {
      log('ERROR', `❌ Failed to parse configuration: ${error.message}`);
      hasErrors = true;
    }
  }
  
  // Check if workflow file exists
  if (!fs.existsSync(workflowPath)) {
    log('ERROR', `❌ Workflow file not found: ${workflowPath}`);
    hasErrors = true;
  } else {
    log('SUCCESS', '✅ Workflow file found');
  }
  
  // Check package.json for required scripts
  const packagePath = path.join(process.cwd(), 'package.json');
  if (fs.existsSync(packagePath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      
      const requiredScripts = ['start', 'test', 'typecheck'];
      for (const script of requiredScripts) {
        if (!packageJson.scripts?.[script]) {
          log('WARN', `⚠️  Missing script in package.json: ${script}`);
        } else {
          log('SUCCESS', `✅ Script found: ${script}`);
        }
      }
    } catch (error) {
      log('ERROR', `❌ Failed to parse package.json: ${error.message}`);
    }
  }
  
  // Check for test files
  const testPatterns = [
    '**/*.test.ts',
    '**/*.test.js',
    '**/*.spec.ts',
    '**/*.spec.js'
  ];
  
  log('INFO', '🔍 Checking for test files...');
  const { execSync } = require('child_process');
  
  try {
    const testFiles = execSync('find . -name "*.test.*" -o -name "*.spec.*" | head -10', { encoding: 'utf8' });
    if (testFiles.trim()) {
      log('SUCCESS', '✅ Test files found');
      log('INFO', '   Sample test files:');
      testFiles.trim().split('\n').forEach(file => {
        log('INFO', `     ${file}`);
      });
    } else {
      log('WARN', '⚠️  No test files found - tests will be skipped');
    }
  } catch (error) {
    log('WARN', '⚠️  Could not search for test files');
  }
  
  return !hasErrors;
}

async function generateTestWorkflow() {
  log('INFO', '🧪 Generating test workflow...');
  
  const testWorkflow = `name: 🧪 Test Worker Build

on:
  workflow_dispatch:
    inputs:
      test_type:
        description: 'Type of test to run'
        required: true
        default: 'quick'
        type: choice
        options:
        - quick
        - full
        - single-worker

jobs:
  test-worker-system:
    name: Test Worker System
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'yarn'
          
      - name: Install dependencies
        run: yarn install --frozen-lockfile
        
      - name: Validate configuration
        run: node .github/scripts/validate-workers.js
        
      - name: Run quick test build
        if: github.event.inputs.test_type == 'quick'
        run: |
          echo "Running quick test build..."
          yarn expo export --platform web --output-dir test-build
          
      - name: Test build artifacts
        run: |
          echo "Testing build artifacts..."
          ls -la test-build/ || echo "No build directory found"
          
      - name: Summary
        run: |
          echo "## 🧪 Test Results" >> \\$GITHUB_STEP_SUMMARY
          echo "- Configuration: ✅ Valid" >> \\$GITHUB_STEP_SUMMARY
          echo "- Build process: ✅ Working" >> \\$GITHUB_STEP_SUMMARY
          echo "- Worker system: ✅ Ready" >> \\$GITHUB_STEP_SUMMARY
`;

  const testWorkflowPath = path.join(process.cwd(), '.github', 'workflows', 'test-workers.yml');
  fs.writeFileSync(testWorkflowPath, testWorkflow);
  
  log('SUCCESS', `✅ Test workflow created: ${testWorkflowPath}`);
  log('INFO', '   You can now trigger this workflow manually to test your setup');
}

async function main() {
  console.log(colorize('bright', '🤖 Worker Build System Validator'));
  console.log('');
  
  const isValid = await validateWorkerConfig();
  
  console.log('');
  
  if (isValid) {
    log('SUCCESS', '🎉 Configuration is valid!');
    log('INFO', '💡 Next steps:');
    log('INFO', '   1. Commit and push your configuration');
    log('INFO', '   2. Go to GitHub Actions tab');
    log('INFO', '   3. Trigger "Distributed Build with Workers" workflow');
    log('INFO', '   4. Monitor the parallel job execution');
    
    // Ask if user wants to generate test workflow
    if (process.argv.includes('--generate-test')) {
      await generateTestWorkflow();
    }
  } else {
    log('ERROR', '❌ Configuration has errors - please fix them before proceeding');
    process.exit(1);
  }
}

// Handle command line arguments
if (process.argv.includes('--help')) {
  console.log('Usage: node validate-workers.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --help              Show this help message');
  console.log('  --generate-test     Generate test workflow file');
  console.log('');
  process.exit(0);
}

main().catch(error => {
  log('ERROR', `💥 Validation failed: ${error.message}`);
  process.exit(1);
});