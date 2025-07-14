#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const MAX_STRING_LENGTH = 200;
const INPUT_DIR = 'example-sessions';
const OUTPUT_DIR = 'example-sessions-simple';

/**
 * Recursively traverse an object and truncate any string longer than maxLength
 */
function truncateStrings(obj, maxLength = MAX_STRING_LENGTH) {
  if (typeof obj === 'string') {
    if (obj.length > maxLength) {
      return obj.substring(0, maxLength) + '... [TRUNCATED]';
    }
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => truncateStrings(item, maxLength));
  }
  
  if (obj !== null && typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = truncateStrings(value, maxLength);
    }
    return result;
  }
  
  return obj;
}

/**
 * Process a single JSONL file
 */
function processJsonlFile(inputPath, outputPath) {
  console.log(`Processing: ${inputPath} -> ${outputPath}`);
  
  const content = fs.readFileSync(inputPath, 'utf8');
  const lines = content.trim().split('\n');
  
  const processedObjects = lines.map(line => {
    try {
      const obj = JSON.parse(line);
      return truncateStrings(obj);
    } catch (error) {
      console.error(`Error parsing line: ${line.substring(0, 100)}...`);
      return null;
    }
  }).filter(obj => obj !== null);
  
  fs.writeFileSync(outputPath, JSON.stringify(processedObjects, null, 2));
  console.log(`✓ Processed ${processedObjects.length} objects`);
}

/**
 * Main function
 */
function main() {
  // Create output directory
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  
  // Get all .jsonl files from input directory
  const files = fs.readdirSync(INPUT_DIR)
    .filter(file => file.endsWith('.jsonl'))
    .sort();
  
  console.log(`Found ${files.length} JSONL files to process`);
  
  // Process each file
  files.forEach(file => {
    const inputPath = path.join(INPUT_DIR, file);
    const outputPath = path.join(OUTPUT_DIR, file.replace('.jsonl', '.json'));
    
    try {
      processJsonlFile(inputPath, outputPath);
    } catch (error) {
      console.error(`Error processing ${file}:`, error.message);
    }
  });
  
  console.log(`\nDone! Check ${OUTPUT_DIR} for results`);
}

if (require.main === module) {
  main();
} 