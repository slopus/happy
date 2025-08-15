/**
 * Global test setup for Vitest
 * 
 * Initializes configuration and logger for all tests
 */

import { initializeConfiguration } from '@/configuration'
import { initLoggerWithGlobalConfiguration } from '@/ui/logger'

// Initialize configuration before all tests
initializeConfiguration()

// Initialize logger after configuration
initLoggerWithGlobalConfiguration()