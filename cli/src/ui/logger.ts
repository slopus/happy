/**
 * Logger utility for handy-cli
 * 
 * This module provides structured logging with different log levels and colors.
 * 
 * Key responsibilities:
 * - Provide consistent logging interface
 * - Color-coded output for different log levels
 * - Timestamp prefixes for better debugging
 */

import chalk from 'chalk'

export enum LogLevel {
  DEBUG = 'DEBUG',
  ERROR = 'ERROR',
  INFO = 'INFO',
  WARN = 'WARN'
}

class Logger {
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
}

export const logger = new Logger()