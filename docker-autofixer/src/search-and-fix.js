const logger = require('./logger');

async function searchAndApplyFixes(repoPath, issues, exaSearch) {
  logger.info(`Searching for solutions to ${issues.length} remaining issues`);

  for (const issue of issues) {
    try {
      if (issue.tool === 'eslint') {
        await fixESLintIssues(repoPath, issue, exaSearch);
      } else if (issue.tool === 'typescript') {
        await fixTypeScriptIssues(repoPath, issue, exaSearch);
      } else if (issue.tool === 'biome') {
        await fixBiomeIssues(repoPath, issue, exaSearch);
      }
    } catch (error) {
      logger.warn(`Failed to fix issue ${issue.tool}: ${error.message}`);
    }
  }
}

async function fixESLintIssues(repoPath, issue, exaSearch) {
  if (!issue.issues || issue.issues.length === 0) return;

  for (const eslintIssue of issue.issues) {
    const { ruleId, message } = eslintIssue;

    if (ruleId) {
      logger.info(`Searching for solution to ESLint rule: ${ruleId}`);

      const searchResults = await exaSearch.findBestPractices('eslint', `${ruleId} ${message}`);

      if (searchResults && searchResults.results) {
        const solutions = extractSolutions(searchResults.results);
        logger.info(`Found ${solutions.length} potential solutions for ${ruleId}`);

        // Apply common ESLint fixes
        await applyCommonESLintFixes(repoPath, ruleId, eslintIssue);
      }
    }
  }
}

async function fixTypeScriptIssues(repoPath, issue, exaSearch) {
  const errorLines = issue.output.split('\n').filter(line => line.includes('error'));

  for (const errorLine of errorLines) {
    const errorPattern = /error TS\d+: (.+)/;
    const match = errorLine.match(errorPattern);

    if (match) {
      const errorMessage = match[1];
      logger.info(`Searching for TypeScript error solution: ${errorMessage}`);

      const searchResults = await exaSearch.findErrorSolutions(errorMessage, 'typescript');

      if (searchResults && searchResults.results) {
        const solutions = extractSolutions(searchResults.results);
        logger.info(`Found ${solutions.length} potential solutions for TypeScript error`);

        // Apply common TypeScript fixes
        await applyCommonTypeScriptFixes(repoPath, errorMessage, errorLine);
      }
    }
  }
}

async function fixBiomeIssues(repoPath, issue, exaSearch) {
  if (!issue.output) return;

  const biomeErrors = parseBiomeOutput(issue.output);

  for (const error of biomeErrors) {
    logger.info(`Searching for Biome solution: ${error.rule}`);

    const searchResults = await exaSearch.findBestPractices('biome', `${error.rule} ${error.message}`);

    if (searchResults && searchResults.results) {
      const solutions = extractSolutions(searchResults.results);
      logger.info(`Found ${solutions.length} potential solutions for Biome issue`);
    }
  }
}

async function applyCommonESLintFixes(repoPath, ruleId, issue) {
  const { exec } = require('child_process');
  const util = require('util');
  const execAsync = util.promisify(exec);

  try {
    switch (ruleId) {
      case 'unused-imports/no-unused-imports':
        await execAsync(`cd "${repoPath}" && npx eslint --fix --rule "unused-imports/no-unused-imports: error" .`);
        break;
      case 'import/order':
        await execAsync(`cd "${repoPath}" && npx eslint --fix --rule "import/order: error" .`);
        break;
      case '@typescript-eslint/no-unused-vars':
        await execAsync(`cd "${repoPath}" && npx eslint --fix --rule "@typescript-eslint/no-unused-vars: error" .`);
        break;
      case 'prettier/prettier':
        await execAsync(`cd "${repoPath}" && npx prettier --write "**/*.{ts,tsx,js,jsx}"`);
        break;
      default:
        // Try generic fix
        await execAsync(`cd "${repoPath}" && npx eslint --fix .`);
    }
    logger.info(`Applied fix for ESLint rule: ${ruleId}`);
  } catch (error) {
    logger.warn(`Failed to apply ESLint fix for ${ruleId}: ${error.message}`);
  }
}

async function applyCommonTypeScriptFixes(repoPath, errorMessage, errorLine) {
  const fs = require('fs-extra');
  const path = require('path');

  try {
    // Extract file path from error line
    const fileMatch = errorLine.match(/(.+\.tsx?)\(\d+,\d+\):/);
    if (!fileMatch) return;

    const filePath = path.resolve(repoPath, fileMatch[1]);
    if (!(await fs.pathExists(filePath))) return;

    let content = await fs.readFile(filePath, 'utf8');
    let modified = false;

    // Common TypeScript fixes
    if (errorMessage.includes('Cannot find module')) {
      // Add missing import
      const moduleMatch = errorMessage.match(/Cannot find module '(.+)'/);
      if (moduleMatch) {
        const moduleName = moduleMatch[1];
        if (!content.includes(`import`) || !content.includes(moduleName)) {
          content = `import ${moduleName.replace(/[^a-zA-Z0-9]/g, '')} from '${moduleName}';\n${content}`;
          modified = true;
        }
      }
    } else if (errorMessage.includes('Property') && errorMessage.includes('does not exist')) {
      // Add optional chaining or type assertions
      const propMatch = errorMessage.match(/Property '(.+)' does not exist/);
      if (propMatch) {
        const propName = propMatch[1];
        content = content.replace(new RegExp(`\\.${propName}(?!\\?)`, 'g'), `.${propName}?`);
        modified = true;
      }
    }

    if (modified) {
      await fs.writeFile(filePath, content);
      logger.info(`Applied TypeScript fix to ${filePath}`);
    }
  } catch (error) {
    logger.warn(`Failed to apply TypeScript fix: ${error.message}`);
  }
}

function extractSolutions(results) {
  return results
    .map(result => ({
      title: result.title,
      url: result.url,
      content: result.text || result.highlights,
      score: result.score,
    }))
    .sort((a, b) => b.score - a.score);
}

function parseBiomeOutput(output) {
  const errors = [];
  const lines = output.split('\n');

  for (const line of lines) {
    if (line.includes('error') || line.includes('warning')) {
      const match = line.match(/(.+?):\s*(.+)/);
      if (match) {
        errors.push({
          rule: match[1].trim(),
          message: match[2].trim(),
        });
      }
    }
  }

  return errors;
}

module.exports = {
  searchAndApplyFixes,
  fixESLintIssues,
  fixTypeScriptIssues,
  fixBiomeIssues,
};
