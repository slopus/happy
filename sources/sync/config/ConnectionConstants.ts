/**
 * Centralized configuration constants for connection management
 * Replaces magic numbers throughout the codebase
 */

export const CONNECTION_TIMEOUTS = {
	// Basic connection timeouts
	DEFAULT_CONNECTION_TIMEOUT: 15000, // 15 seconds
	PING_TIMEOUT: 10000, // 10 seconds
	WEBSOCKET_TIMEOUT: 30000, // 30 seconds

	// Retry timeouts
	BASE_RETRY_DELAY: 1000, // 1 second
	MAX_RETRY_DELAY: 30000, // 30 seconds

	// Health check timeouts
	HEALTH_CHECK_TIMEOUT: 5000, // 5 seconds
	HEALTH_CHECK_INTERVAL: 30000, // 30 seconds
} as const;

export const CONNECTION_LIMITS = {
	// Memory management
	MAX_METRICS_STORAGE: 50,
	MAX_FAILURE_HISTORY: 100,
	MAX_LATENCY_HISTORY: 50,
	MAX_LOG_ENTRIES: 5000,

	// Training data limits
	MAX_TRAINING_DATA: 1000,
	TRAINING_DATA_TRIM_SIZE: 500,
	MAX_PREDICTION_HISTORY: 100,
	PREDICTION_TRIM_SIZE: 50,

	// Network testing
	MAX_LATENCY_TESTS: 100,
	LATENCY_TEST_TRIM_SIZE: 50,
} as const;

export const CONNECTION_INTERVALS = {
	// Heartbeat profiles
	HEARTBEAT_STANDARD: 30000, // 30 seconds
	HEARTBEAT_AGGRESSIVE: 15000, // 15 seconds
	HEARTBEAT_CORPORATE: 10000, // 10 seconds
	HEARTBEAT_BATTERY_SAVER: 60000, // 60 seconds

	// Monitoring intervals
	NETWORK_CHANGE_CHECK: 5000, // 5 seconds
	CLEANUP_INTERVAL: 300000, // 5 minutes
	METRICS_PERSIST_INTERVAL: 60000, // 1 minute

	// Auto-detection intervals
	AUTO_PROFILE_CHECK_SAMPLES: 10, // Every 10 samples
	FAILURE_CLEANUP_WINDOW: 3600000, // 1 hour
} as const;

export const CONNECTION_THRESHOLDS = {
	// Learning thresholds
	LEARNING_THRESHOLD: 10, // Minimum samples for learning
	PREDICTION_ACCURACY_MIN: 0.85, // Minimum ML accuracy

	// Quality thresholds (latency in ms)
	LATENCY_EXCELLENT: 100,
	LATENCY_GOOD: 500,
	LATENCY_POOR: 2000,

	// Success rate thresholds
	SUCCESS_RATE_EXCELLENT: 0.95,
	SUCCESS_RATE_GOOD: 0.9,
	SUCCESS_RATE_POOR: 0.7,

	// Failure detection thresholds
	MAX_CONSECUTIVE_FAILURES_STANDARD: 3,
	MAX_CONSECUTIVE_FAILURES_AGGRESSIVE: 2,
	MAX_CONSECUTIVE_FAILURES_CORPORATE: 1,
	MAX_CONSECUTIVE_FAILURES_BATTERY_SAVER: 5,

	// Auto-profile detection thresholds
	HIGH_FAILURE_THRESHOLD: 10,
	MODERATE_FAILURE_THRESHOLD: 3,
	HIGH_LATENCY_THRESHOLD: 800,
	LOW_LATENCY_THRESHOLD: 200,
	NETWORK_CHANGE_THRESHOLD: 5,
} as const;

export const CONNECTION_MULTIPLIERS = {
	// Backoff multipliers
	EXPONENTIAL_BACKOFF: 2.0,
	CONSERVATIVE_BACKOFF: 1.5,

	// Timeout calculation multipliers
	LATENCY_TIMEOUT_MULTIPLIER: 5, // timeout = latency * 5
	RELIABILITY_BUFFER_BASE: 1.0,

	// Learning rate and weights
	ROLLING_AVERAGE_ALPHA: 0.1,
	ML_LEARNING_RATE: 0.01,
	SAMPLE_WEIGHT_FACTOR: 0.5,
} as const;

export const CONNECTION_RANGES = {
	// Heartbeat ranges (ms)
	HEARTBEAT_MIN: 5000,
	HEARTBEAT_MAX: 60000,

	// Timeout ranges (ms)
	TIMEOUT_MIN: 5000,
	TIMEOUT_MAX: 30000,

	// Retry ranges
	RETRY_MIN: 1,
	RETRY_MAX: 10,
	RETRY_DELAY_MIN: 500,
	RETRY_DELAY_MAX: 5000,

	// Network quality score ranges
	QUALITY_SCORE_MIN: 0.0,
	QUALITY_SCORE_MAX: 1.0,
} as const;

export const NETWORK_SETTINGS = {
	// Default settings by network type
	WIFI_HEARTBEAT: 30000,
	CELLULAR_HEARTBEAT: 45000,
	POOR_QUALITY_HEARTBEAT: 60000,

	// Cellular-specific settings
	CELLULAR_TIMEOUT: 20000,
	CELLULAR_MAX_RETRIES: 5,

	// Poor connection settings
	POOR_TIMEOUT: 25000,
	POOR_MAX_RETRIES: 7,
} as const;
