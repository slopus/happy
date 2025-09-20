/**
 * Standardized error handling utilities
 * Provides consistent error handling patterns across the codebase
 */

import { log } from "@/log";

export interface ErrorContext {
	operation: string;
	source?: string;
	metadata?: Record<string, unknown>;
}

export class ConnectionError extends Error {
	constructor(
		message: string,
		public readonly code: string,
		public readonly context?: ErrorContext,
		public readonly originalError?: Error,
	) {
		super(message);
		this.name = "ConnectionError";

		// Maintain stack trace
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, ConnectionError);
		}
	}
}

export class TimeoutError extends ConnectionError {
	constructor(
		message: string,
		public readonly timeoutMs: number,
		context?: ErrorContext,
		originalError?: Error,
	) {
		super(message, "TIMEOUT", context, originalError);
		this.name = "TimeoutError";
	}
}

export class NetworkError extends ConnectionError {
	constructor(
		message: string,
		public readonly networkType?: string,
		context?: ErrorContext,
		originalError?: Error,
	) {
		super(message, "NETWORK_ERROR", context, originalError);
		this.name = "NetworkError";
	}
}

export class ErrorHandler {
	/**
	 * Wrap async operations with standardized error handling
	 */
	static async wrapAsync<T>(
		operation: () => Promise<T>,
		context: ErrorContext,
	): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			const wrappedError = this.wrapError(error, context);
			log.error(
				`Operation failed: ${context.operation} - Source: ${context.source} - Error: ${wrappedError}`,
			);
			throw wrappedError;
		}
	}

	/**
	 * Wrap sync operations with standardized error handling
	 */
	static wrapSync<T>(operation: () => T, context: ErrorContext): T {
		try {
			return operation();
		} catch (error) {
			const wrappedError = this.wrapError(error, context);
			log.error(
				`Operation failed: ${context.operation} - Source: ${context.source} - Error: ${wrappedError}`,
			);
			throw wrappedError;
		}
	}

	/**
	 * Wrap Promise with timeout handling
	 */
	static async withTimeout<T>(
		promise: Promise<T>,
		timeoutMs: number,
		context: ErrorContext,
	): Promise<T> {
		const timeoutPromise = new Promise<never>((_, reject) => {
			setTimeout(() => {
				reject(
					new TimeoutError(
						`Operation timed out after ${timeoutMs}ms`,
						timeoutMs,
						context,
					),
				);
			}, timeoutMs);
		});

		return Promise.race([promise, timeoutPromise]);
	}

	/**
	 * Wrap error with context information
	 */
	static wrapError(error: unknown, context: ErrorContext): ConnectionError {
		if (error instanceof ConnectionError) {
			return error; // Already wrapped
		}

		const originalError =
			error instanceof Error ? error : new Error(String(error));
		const message = `${context.operation}: ${originalError.message}`;

		// Detect specific error types
		if (this.isTimeoutError(originalError)) {
			return new TimeoutError(message, 0, context, originalError);
		}

		if (this.isNetworkError(originalError)) {
			return new NetworkError(message, undefined, context, originalError);
		}

		return new ConnectionError(message, "UNKNOWN", context, originalError);
	}

	/**
	 * Handle errors with logging and optional recovery
	 */
	static handleError(
		error: unknown,
		context: ErrorContext,
		recovery?: () => void,
	): ConnectionError {
		const wrappedError = this.wrapError(error, context);

		log.error(
			`Error in ${context.operation} - Source: ${context.source} - Error: ${wrappedError}`,
		);

		if (recovery) {
			try {
				recovery();
			} catch (recoveryError) {
				log.error(
					`Recovery failed for ${context.operation} - Source: ${context.source} - Error: ${recoveryError as Error}`,
				);
			}
		}

		return wrappedError;
	}

	/**
	 * Create retry wrapper with exponential backoff
	 */
	static async withRetry<T>(
		operation: () => Promise<T>,
		options: {
			maxRetries: number;
			baseDelayMs: number;
			backoffMultiplier?: number;
			jitter?: boolean;
			context: ErrorContext;
		},
	): Promise<T> {
		const {
			maxRetries,
			baseDelayMs,
			backoffMultiplier = 2,
			jitter = true,
			context,
		} = options;
		let lastError: Error;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				return await operation();
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));

				if (attempt === maxRetries) {
					break; // Don't wait after the last attempt
				}

				// Calculate delay with exponential backoff
				let delay = baseDelayMs * Math.pow(backoffMultiplier, attempt);

				// Add jitter to prevent thundering herd
				if (jitter) {
					delay *= 0.5 + Math.random() * 0.5;
				}

				log.log(
					`WARN: Retry ${attempt + 1}/${maxRetries} for ${context.operation} after ${delay}ms - Source: ${context.source}`,
				);

				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}

		throw this.wrapError(lastError!, context);
	}

	/**
	 * Detect if error is timeout-related
	 */
	private static isTimeoutError(error: Error): boolean {
		const message = error.message.toLowerCase();
		return (
			message.includes("timeout") ||
			message.includes("timed out") ||
			error.name === "TimeoutError"
		);
	}

	/**
	 * Detect if error is network-related
	 */
	private static isNetworkError(error: Error): boolean {
		const message = error.message.toLowerCase();
		return (
			message.includes("network") ||
			message.includes("connection") ||
			message.includes("socket") ||
			message.includes("fetch") ||
			error.name === "NetworkError"
		);
	}
}

/**
 * Decorator for methods that need standardized error handling
 */
export function withErrorHandling(context: Partial<ErrorContext>) {
	return function (
		target: any,
		propertyName: string,
		descriptor: PropertyDescriptor,
	) {
		const method = descriptor.value;

		descriptor.value = async function (...args: any[]) {
			const fullContext: ErrorContext = {
				operation: `${target.constructor.name}.${propertyName}`,
				source: target.constructor.name,
				...context,
			};

			return ErrorHandler.wrapAsync(
				() => method.apply(this, args),
				fullContext,
			);
		};
	};
}
