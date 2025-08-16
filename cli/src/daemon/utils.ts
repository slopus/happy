/**
 * Daemon utility functions
 * 
 * Provides status checking and control functions for the daemon
 * Extracted to avoid circular dependencies with ui/doctor.ts
 */

import { DaemonMetadata } from './types';
import { logger } from '@/ui/logger';
import { existsSync, unlinkSync, readFileSync } from 'fs';
import { configuration } from '@/configuration';
import { stopCaffeinate } from '@/utils/caffeinate';

export async function isDaemonRunning(): Promise<boolean> {
  try {
    const metadata = await getDaemonMetadata();
    if (!metadata) {
      return false;
    }
    
    const isRunning = await isDaemonProcessRunning(metadata.pid);
    if (!isRunning) {
      logger.debug('[DAEMON RUN] Daemon PID not running, cleaning up metadata');
      await cleanupDaemonMetadata();
      return false;
    }
    
    return true;
  } catch (error) {
    logger.debug('[DAEMON RUN] Error checking daemon status', error);
    return false;
  }
}

export async function getDaemonMetadata(): Promise<DaemonMetadata | null> {
  try {
    if (!existsSync(configuration.daemonMetadataFile)) {
      return null;
    }
    const content = readFileSync(configuration.daemonMetadataFile, 'utf-8');
    return JSON.parse(content) as DaemonMetadata;
  } catch (error) {
    logger.debug('[DAEMON RUN] Error reading daemon metadata', error);
    return null;
  }
}

async function isDaemonProcessRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function cleanupDaemonMetadata(): Promise<void> {
  try {
    if (existsSync(configuration.daemonMetadataFile)) {
      unlinkSync(configuration.daemonMetadataFile);
      logger.debug('[DAEMON RUN] Daemon metadata file removed');
    }
  } catch (error) {
    logger.debug('[DAEMON RUN] Error cleaning up daemon metadata', error);
  }
}

export async function stopDaemon() {
  try {
    stopCaffeinate();
    logger.debug('Stopped sleep prevention');

    const metadata = await getDaemonMetadata();
    if (!metadata) {
      logger.debug('No daemon metadata found');
      return;
    }

    logger.debug(`Stopping daemon with PID ${metadata.pid}`);
    
    // Try HTTP graceful stop
    try {
      const { stopDaemonHttp } = await import('./controlClient');
      await stopDaemonHttp();
      
      // Wait for daemon to die
      await waitForProcessDeath(metadata.pid, 5000);
      logger.debug('Daemon stopped gracefully via HTTP');
      return;
    } catch (error) {
      logger.debug('HTTP stop failed, will force kill', error);
    }
    
    // Force kill
    try {
      process.kill(metadata.pid, 'SIGKILL');
      logger.debug('Force killed daemon');
    } catch (error) {
      logger.debug('Daemon already dead');
    }
  } catch (error) {
    logger.debug('Error stopping daemon', error);
  }
}

async function waitForProcessDeath(pid: number, timeout: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      process.kill(pid, 0);
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch {
      return; // Process is dead
    }
  }
  throw new Error('Process did not die within timeout');
}