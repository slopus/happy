const { exec } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

class ClaudeCodeIntegration {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  async runClaudeCode(repoPath, prompt, files = []) {
    try {
      // Set up Claude Code environment
      process.env.CLAUDE_API_KEY = this.apiKey;

      // Create a temporary file with the prompt
      const promptFile = path.join(repoPath, '.claude-prompt.txt');
      await fs.writeFile(promptFile, prompt);

      let command = `cd "${repoPath}" && claude-code`;

      // Add specific files if provided
      if (files.length > 0) {
        command += ` ${files.map(f => `"${f}"`).join(' ')}`;
      }

      // Add the prompt
      command += ` --prompt "$(cat .claude-prompt.txt)"`;

      const result = await this.runCommand(command);

      // Clean up
      await fs.remove(promptFile);

      return result;
    } catch (error) {
      throw new Error(`Claude Code execution failed: ${error.message}`);
    }
  }

  async fixTypeScriptErrors(repoPath, errors) {
    const prompt = `
Please fix the following TypeScript errors in this React Native Expo project:

${errors.map(error => `- ${error.file}: ${error.message}`).join('\n')}

Requirements:
1. Fix all TypeScript compilation errors
2. Maintain existing functionality
3. Follow React Native and Expo best practices
4. Use proper type definitions
5. Ensure code remains compatible with Expo SDK 53

Apply fixes systematically and ensure the code compiles successfully.
`;

    return await this.runClaudeCode(repoPath, prompt);
  }

  async fixESLintErrors(repoPath, errors) {
    const prompt = `
Please fix the following ESLint errors in this React Native Expo project:

${errors.map(error => `- ${error.file}: ${error.message} (${error.rule})`).join('\n')}

Requirements:
1. Fix all ESLint errors while maintaining code functionality
2. Follow the project's ESLint configuration
3. Use proper imports and exports
4. Maintain code style consistency
5. Apply best practices for React Native development

Make minimal changes to fix the issues without altering core functionality.
`;

    return await this.runClaudeCode(repoPath, prompt);
  }

  async optimizePerformance(repoPath) {
    const prompt = `
Please analyze and optimize this React Native Expo project for performance:

1. Review component rendering patterns
2. Check for unnecessary re-renders
3. Optimize imports and bundle size
4. Improve state management efficiency
5. Add proper memoization where needed

Focus on:
- React.memo for components
- useCallback/useMemo for expensive operations
- Proper dependency arrays
- Import optimization
- Image optimization

Apply optimizations while maintaining functionality.
`;

    return await this.runClaudeCode(repoPath, prompt);
  }

  runCommand(command) {
    return new Promise((resolve, reject) => {
      exec(command, { timeout: 300000 }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  }
}

module.exports = ClaudeCodeIntegration;
