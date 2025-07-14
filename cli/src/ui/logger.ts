/**
 * Logger utility for handy-cli
 * 
 * This module provides structured logging with different log levels and colors.
 * 
 * Key responsibilities:
 * - Provide consistent logging interface
 * - Color-coded output for different log levels (console mode)
 * - Timestamp prefixes for better debugging
 * - Configurable output destination (console or file)
 * 
 * Design decisions:
 * - Default to file output for better debugging persistence
 * - File output location: cwd/debug.log
 * - Strip colors when writing to file
 */

import chalk from 'chalk'
import { writeFileSync, appendFileSync, existsSync } from 'fs'
import { join } from 'path'

export enum LogLevel {
  DEBUG = 'DEBUG',
  ERROR = 'ERROR',
  INFO = 'INFO',
  WARN = 'WARN'
}


class Logger {
  private destination: 'console' | 'file' = 'file'
  private logFilePath: string

  constructor() {
    this.logFilePath = join(process.cwd(), 'debug.log')

    if (this.destination === 'file' && existsSync(this.logFilePath)) {
      writeFileSync(this.logFilePath, '')
    }
  }

  debug(message: string, ...args: unknown[]): void {
    if (process.env.DEBUG) {
      this.log(LogLevel.DEBUG, message, ...args)
    }
  }
  
  error(message: string, ...args: unknown[]): void {
    this.log(LogLevel.ERROR, message, ...args)
  }
  
  info(message: string, ...args: unknown[]): void {
    this.log(LogLevel.INFO, message, ...args)
  }
  
  warn(message: string, ...args: unknown[]): void {
    this.log(LogLevel.WARN, message, ...args)
  }
  
  private getTimestamp(): string {
    return new Date().toISOString()
  }
  
  private log(level: LogLevel, message: string, ...args: unknown[]): void {
    const timestamp = this.getTimestamp()
    const prefix = `[${timestamp}] [${level}]`
    
    if (this.destination === 'console') {
      this.logToConsole(level, prefix, message, ...args)
    } else {
      this.logToFile(prefix, message, ...args)
    }
  }

  private logToConsole(level: LogLevel, prefix: string, message: string, ...args: unknown[]): void {
    switch (level) {
      case LogLevel.DEBUG: {
        console.log(chalk.gray(prefix), message, ...args)
        break
      }

      case LogLevel.ERROR: {
        console.error(chalk.red(prefix), message, ...args)
        break
      }

      case LogLevel.INFO: {
        console.log(chalk.blue(prefix), message, ...args)
        break
      }

      case LogLevel.WARN: {
        console.log(chalk.yellow(prefix), message, ...args)
        break
      }
    }
  }

  private logToFile(prefix: string, message: string, ...args: unknown[]): void {
    const logLine = `${prefix} ${message} ${args.map(arg => 
      typeof arg === 'string' ? arg : JSON.stringify(arg)
    ).join(' ')}\n`
    
    try {
      appendFileSync(this.logFilePath, logLine)
    } catch (error) {
      // Fallback to console if file write fails
      console.error('Failed to write to log file:', error)
      console.log(prefix, message, ...args)
    }
  }
}

export const logger = new Logger()