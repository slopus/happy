import { Command } from 'commander';
import prompts from 'prompts';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { uploadFile } from './upload.js';

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) {
    return `${diffSeconds} seconds ago`;
  } else if (diffMinutes < 60) {
    return `${diffMinutes} minutes ago`;
  } else if (diffHours < 24) {
    return `${diffHours} hours ago`;
  } else {
    return `${diffDays} days ago`;
  }
}

function transformPathToProjectName(cwd: string): string {
  // Replace all non-path characters with dashes
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

interface ProjectFile {
  name: string;
  path: string;
  projectName: string;
  sortTime: Date;
  displayName: string;
}

function getAllProjectFiles(claudeProjectsDir: string): ProjectFile[] {
  const allFiles: ProjectFile[] = [];
  
  try {
    const projectDirs = fs.readdirSync(claudeProjectsDir);
    
    for (const projectDir of projectDirs) {
      const projectPath = path.join(claudeProjectsDir, projectDir);
      
      if (fs.statSync(projectPath).isDirectory()) {
        try {
          const files = fs.readdirSync(projectPath)
            .filter(file => file.endsWith('.jsonl'))
            .map(file => {
              const filePath = path.join(projectPath, file);
              const stats = fs.statSync(filePath);
              return {
                name: file,
                path: filePath,
                projectName: projectDir,
                sortTime: stats.mtime > stats.ctime ? stats.mtime : stats.ctime,
                displayName: `${projectDir}/${file}`
              };
            });
          
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
  
  return allFiles
    .sort((a, b) => b.sortTime.getTime() - a.sortTime.getTime())
    .slice(0, 5);
}

export const recentCommand = new Command('recent')
  .description('Select from recent Claude project files')
  .option('-k, --key <key>', 'Base64 encoded secret key for upload')
  .option('-i, --interactive', 'Prompt before sending each message during upload')
  .option('-d, --delay <seconds>', 'Delay between messages in seconds during upload', '0')
  .option('-n, --new-session', 'Generate a new random session ID instead of using filename for upload')
  .action(async (options: { key?: string; interactive?: boolean; delay?: string; newSession?: boolean }) => {
    try {
      const cwd = process.cwd();
      const homeDir = os.homedir();
      const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');
      
      // Check if Claude projects directory exists
      if (!fs.existsSync(claudeProjectsDir)) {
        console.error('Claude projects directory not found at:', claudeProjectsDir);
        return;
      }
      
      // Transform current working directory to Claude project format
      const projectName = transformPathToProjectName(cwd);
      const projectDir = path.join(claudeProjectsDir, projectName);
      
      let files: ProjectFile[] = [];
      let isCurrentProject = false;
      
      // Check if the specific project directory exists
      if (fs.existsSync(projectDir)) {
        isCurrentProject = true;
        
        // Get files from current project
        const currentProjectFiles = fs.readdirSync(projectDir)
          .filter(file => file.endsWith('.jsonl'))
          .map(file => {
            const filePath = path.join(projectDir, file);
            const stats = fs.statSync(filePath);
            return {
              name: file,
              path: filePath,
              projectName: projectName,
              sortTime: stats.mtime > stats.ctime ? stats.mtime : stats.ctime,
              displayName: file
            };
          })
          .sort((a, b) => b.sortTime.getTime() - a.sortTime.getTime())
          .slice(0, 5);
        
        files = currentProjectFiles;
        
        // Print the project directory name for orientation
        console.log(`\nClaude project: ${projectName}\n`);
      } else {
        // Not in a claude project, search all projects
        console.log('Not in a Claude project, searching all projects for 5 most recent files...\n');
        files = getAllProjectFiles(claudeProjectsDir);
      }

      if (files.length === 0) {
        if (isCurrentProject) {
          console.log('No .jsonl files found in the current Claude project.');
        } else {
          console.log('No .jsonl files found in any Claude projects.');
        }
        return;
      }

      // Create choices for the prompt
      const choices = [
        { title: 'Do nothing (default)', value: 'nothing' },
        ...files.map(file => ({
          title: `${formatRelativeTime(file.sortTime)} - ${file.sortTime.toISOString()} - ${file.displayName}`,
          value: file.path
        }))
      ];

      const response = await prompts({
        type: 'select',
        name: 'file',
        message: 'Select a recent Claude project file',
        choices,
        initial: 0
      });

      if (response.file === undefined) {
        console.error('Selection cancelled.');
        return;
      } else if (response.file === 'nothing') {
        console.log('Nothing selected.');
        return;
      } else {
        console.log('Selected file:', response.file);
        
        // Offer to upload the selected file
        const uploadResponse = await prompts({
          type: 'confirm',
          name: 'shouldUpload',
          message: 'Would you like to upload this file to a Claude session?',
          initial: false
        });

        if (uploadResponse.shouldUpload === undefined) {
          console.log('Upload cancelled.');
          return;
        }

        if (uploadResponse.shouldUpload) {
          try {
            console.log('Starting upload...');
            await uploadFile(response.file, {
              key: options.key,
              interactive: options.interactive,
              delay: options.delay,
              newSession: options.newSession
            });
            console.log('Upload completed successfully!');
          } catch (error) {
            console.error('Upload failed:', error);
          }
        } else {
          console.log('Upload skipped.');
        }
      }
    } catch (error) {
      console.error('Error accessing Claude project files:', error);
    }
  });