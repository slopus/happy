import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RawJSONLinesSchema } from 'slopus/lib';

/**
 * Find Command - Tool Usage Analysis
 * 
 * Purpose: This command is designed to collect examples of tool usage from Claude Code session files
 * for reverse engineering the file format. The goal is to better understand what information is
 * available in the JSONL files to enable the development of components that can render live status
 * of tool executions.
 * 
 * The command searches through all JSONL files in ~/.claude/projects and extracts:
 * - tool_use_id: The unique identifier for each tool invocation
 * - input: The input parameters passed to the tool
 * - output: The result returned from the tool execution
 * 
 * This data helps engineers understand:
 * 1. The structure of tool use entries in the session files
 * 2. How tool results are associated with their corresponding tool uses
 * 3. What metadata is available for building real-time status indicators
 * 4. The relationship between assistant messages (tool_use) and user messages (tool_result)
 * 
 * Use case: When building UI components that need to show live status of tool executions,
 * this command provides the raw data needed to understand the available information
 * and design appropriate data structures for status rendering.
 */

interface ToolUseResult {
  tool_use_id: string;
  input: unknown;
  output: unknown;
}

function getAllProjectFiles(claudeProjectsDir: string): string[] {
  const allFiles: string[] = [];
  
  try {
    const projectDirs = fs.readdirSync(claudeProjectsDir);
    
    for (const projectDir of projectDirs) {
      const projectPath = path.join(claudeProjectsDir, projectDir);
      
      if (fs.statSync(projectPath).isDirectory()) {
        try {
          const files = fs.readdirSync(projectPath)
            .filter(file => file.endsWith('.jsonl'))
            .map(file => path.join(projectPath, file));
          
          allFiles.push(...files);
        } catch (error) {
          // Skip directories that can't be read
          continue;
        }
      }
    }
  } catch (error) {
    // Handle case where we can't read the projects directory
  }
  
  return allFiles;
}

function findToolUsesInFile(filePath: string, toolName: string): ToolUseResult[] {
  const results: ToolUseResult[] = [];
  
  try {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const lines = fileContent.trim().split('\n');
    
    // Track tool uses with their results (1:1 relationship)
    const toolUses = new Map<string, { input: unknown; toolName: string; output?: unknown }>();
    
    for (const line of lines) {
      if (!line.trim()) continue;
      
      try {
        const parsed = JSON.parse(line);
        const validated = RawJSONLinesSchema.parse(parsed);
        
        if (validated.type === 'assistant') {
          // Look for tool_use content blocks
          for (const content of validated.message.content) {
            if (content.type === 'tool_use' && content.name === toolName) {
              toolUses.set(content.id, { input: content.input, toolName: content.name });
            }
          }
        } else if (validated.type === 'user') {
          // Look for tool results in message content
          if (Array.isArray(validated.message.content)) {
            for (const content of validated.message.content) {
              if (content.type === 'tool_result') {
                const entry = toolUses.get(content.tool_use_id);
                if (entry) {
                  entry.output = content.content;
                }
              }
            }
          }
          
          // Also check for toolUseResult in the entry itself
          if (validated.toolUseResult) {
            // This is the result from the tool execution
            // Associate it with the most recent tool use that doesn't have an output yet
            for (const [toolUseId, toolUse] of toolUses) {
              if (toolUse.output === undefined) {
                toolUse.output = validated.toolUseResult;
                break; // Only associate with the first tool use that doesn't have an output
              }
            }
          }
        }
      } catch (error) {
        console.error(`Failed to parse line in ${filePath}:`, error);
        console.error('Line content:', line);
        process.exit(1);
      }
    }
    
    // Build results from matched tool uses
    for (const [toolUseId, toolUse] of toolUses) {
      results.push({
        tool_use_id: toolUseId,
        input: toolUse.input,
        output: toolUse.output
      });
    }
    
  } catch (error) {
    console.error(`Failed to read file ${filePath}:`, error);
    process.exit(1);
  }
  
  return results;
}

export const findCommand = new Command('find')
  .description('Find tool usage in Claude project files')
  .requiredOption('-t, --tool <toolName>', 'Tool name to search for')
  .action(async (options: { tool: string }) => {
    try {
      const homeDir = os.homedir();
      const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');
      
      // Check if Claude projects directory exists
      if (!fs.existsSync(claudeProjectsDir)) {
        console.error('Claude projects directory not found at:', claudeProjectsDir);
        return;
      }
      
      console.error(`Searching for tool usage of "${options.tool}" in all Claude project files...`);
      
      const allFiles = getAllProjectFiles(claudeProjectsDir);
      
      if (allFiles.length === 0) {
        console.error('No .jsonl files found in any Claude projects.');
        return;
      }
      
              console.error(`Found ${allFiles.length} JSONL files to search.`);
      
      const allResults: ToolUseResult[] = [];
      
      for (const filePath of allFiles) {
        const fileResults = findToolUsesInFile(filePath, options.tool);
        allResults.push(...fileResults);
      }
      
      if (allResults.length === 0) {
        console.error(`No tool usage found for "${options.tool}" in any files.`);
        return;
      }
      
              console.error(`\nFound ${allResults.length} tool usage(s) for "${options.tool}":\n`);
      console.log(JSON.stringify(allResults, null, 2));
      
    } catch (error) {
      console.error('Error searching for tool usage:', error);
      process.exit(1);
    }
  }); 