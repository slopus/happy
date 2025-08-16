#!/usr/bin/env node

/**
 * Standalone script to kill runaway Happy CLI processes
 * Used for emergency cleanup when daemon crashes and leaves orphaned children
 */

import { findRunawayHappyProcesses, killRunawayHappyProcesses } from './utils';

async function main() {
  console.log('🔍 Scanning for runaway Happy CLI processes...');
  
  const runawayProcesses = findRunawayHappyProcesses();
  
  if (runawayProcesses.length === 0) {
    console.log('✅ No runaway processes found');
    return;
  }
  
  console.log(`\n📋 Found ${runawayProcesses.length} runaway processes:`);
  for (const { pid, command } of runawayProcesses) {
    console.log(`  PID ${pid}: ${command.substring(0, 80)}...`);
  }
  
  console.log('\n💀 Killing runaway processes...');
  const result = await killRunawayHappyProcesses();
  
  console.log(`\n✅ Results:`);
  console.log(`  - Killed: ${result.killed} processes`);
  
  if (result.errors.length > 0) {
    console.log(`  - Errors: ${result.errors.length}`);
    for (const { pid, error } of result.errors) {
      console.log(`    PID ${pid}: ${error}`);
    }
  }
}

if (require.main === module) {
  main().catch(console.error);
}