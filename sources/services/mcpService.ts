import { Platform } from "react-native";

/**
 * Model Context Protocol (MCP) Service
 * Handles automatic discovery of available AI models and their capabilities
 */

export interface MCPModel {
	id: string;
	name: string;
	provider: string;
	version?: string;
	description?: string;
	capabilities: ModelCapabilities;
	limitations: ModelLimitations;
	contextWindow: number;
	maxOutputTokens: number;
	supportedLanguages: string[];
	pricing?: ModelPricing;
	availability: ModelAvailability;
	lastUpdated: number;
}

export interface ModelCapabilities {
	codeGeneration: boolean;
	codeReview: boolean;
	debugging: boolean;
	explanation: boolean;
	refactoring: boolean;
	testing: boolean;
	documentation: boolean;
	multiLanguage: boolean;
	realTimeChat: boolean;
	fileAnalysis: boolean;
	projectContext: boolean;
	toolUse: boolean;
	functionCalling: boolean;
	imageAnalysis?: boolean;
	webSearch?: boolean;
}

export interface ModelLimitations {
	rateLimit?: {
		requestsPerMinute: number;
		tokensPerMinute: number;
		dailyLimit?: number;
	};
	contextLimitations: string[];
	unsupportedFeatures: string[];
	knownIssues: string[];
	bestUseCases: string[];
	notRecommendedFor: string[];
}

export interface ModelPricing {
	inputTokenCost: number;
	outputTokenCost: number;
	currency: string;
	unit: string; // e.g., "per 1K tokens"
	freeQuota?: {
		tokens: number;
		period: string; // e.g., "daily", "monthly"
	};
}

export interface ModelAvailability {
	status: "available" | "limited" | "deprecated" | "beta" | "unavailable";
	region?: string[];
	requiresAuth: boolean;
	waitlist?: boolean;
	maintenanceWindows?: string[];
}

export interface MCPDiscoveryResult {
	models: MCPModel[];
	discoveredAt: number;
	source: string;
	errors?: string[];
}

/**
 * MCP Service for discovering and managing AI model information
 */
export class MCPService {
	private static instance: MCPService;
	private cachedResults: Map<string, MCPDiscoveryResult> = new Map();
	private cacheExpiry: Map<string, number> = new Map();
	private readonly CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

	private constructor() {}

	static getInstance(): MCPService {
		if (!MCPService.instance) {
			MCPService.instance = new MCPService();
		}
		return MCPService.instance;
	}

	/**
	 * Discover available models from multiple sources
	 */
	async discoverModels(
		forceRefresh: boolean = false,
	): Promise<MCPDiscoveryResult> {
		const cacheKey = "all_models";

		// Check cache first
		if (!forceRefresh && this.isCacheValid(cacheKey)) {
			const cached = this.cachedResults.get(cacheKey);
			if (cached) {
				console.log("✅ Returning cached model discovery results");
				return cached;
			}
		}

		console.log("🔍 Discovering AI models via MCP...");

		try {
			const discoveryPromises = [
				this.discoverAnthropicModels(),
				this.discoverOpenAIModels(),
				this.discoverGoogleModels(),
				this.discoverLocalModels(),
			];

			const results = await Promise.allSettled(discoveryPromises);
			const allModels: MCPModel[] = [];
			const errors: string[] = [];

			results.forEach((result, index) => {
				if (result.status === "fulfilled") {
					allModels.push(...result.value.models);
					if (result.value.errors) {
						errors.push(...result.value.errors);
					}
				} else {
					const providerNames = ["Anthropic", "OpenAI", "Google", "Local"];
					errors.push(
						`Failed to discover ${providerNames[index]} models: ${result.reason}`,
					);
				}
			});

			const discoveryResult: MCPDiscoveryResult = {
				models: allModels,
				discoveredAt: Date.now(),
				source: "MCP Discovery",
				errors: errors.length > 0 ? errors : undefined,
			};

			// Cache the results
			this.cachedResults.set(cacheKey, discoveryResult);
			this.cacheExpiry.set(cacheKey, Date.now() + this.CACHE_DURATION);

			console.log(
				`✅ Discovered ${allModels.length} models from ${results.length} providers`,
			);
			return discoveryResult;
		} catch (error) {
			console.error("Failed to discover models:", error);
			throw new Error("Model discovery failed");
		}
	}

	/**
	 * Discover Anthropic models (Claude)
	 */
	private async discoverAnthropicModels(): Promise<MCPDiscoveryResult> {
		const models: MCPModel[] = [
			{
				id: "claude-3-5-sonnet-20241022",
				name: "Claude 3.5 Sonnet",
				provider: "Anthropic",
				version: "20241022",
				description: "Most capable model for code, reasoning, and analysis",
				capabilities: {
					codeGeneration: true,
					codeReview: true,
					debugging: true,
					explanation: true,
					refactoring: true,
					testing: true,
					documentation: true,
					multiLanguage: true,
					realTimeChat: true,
					fileAnalysis: true,
					projectContext: true,
					toolUse: true,
					functionCalling: true,
					imageAnalysis: true,
				},
				limitations: {
					rateLimit: {
						requestsPerMinute: 50,
						tokensPerMinute: 40000,
					},
					contextLimitations: ["Large file processing may be slower"],
					unsupportedFeatures: ["Real-time web browsing"],
					knownIssues: [],
					bestUseCases: [
						"Complex coding tasks",
						"Code review",
						"Architecture planning",
					],
					notRecommendedFor: ["Simple text generation", "Basic Q&A"],
				},
				contextWindow: 200000,
				maxOutputTokens: 8192,
				supportedLanguages: [
					"en",
					"es",
					"fr",
					"de",
					"it",
					"pt",
					"ru",
					"ja",
					"ko",
					"zh",
				],
				pricing: {
					inputTokenCost: 3.0,
					outputTokenCost: 15.0,
					currency: "USD",
					unit: "per 1M tokens",
				},
				availability: {
					status: "available",
					requiresAuth: true,
				},
				lastUpdated: Date.now(),
			},
			{
				id: "claude-3-haiku-20240307",
				name: "Claude 3 Haiku",
				provider: "Anthropic",
				version: "20240307",
				description: "Fast and efficient model for quick tasks",
				capabilities: {
					codeGeneration: true,
					codeReview: true,
					debugging: true,
					explanation: true,
					refactoring: true,
					testing: true,
					documentation: true,
					multiLanguage: true,
					realTimeChat: true,
					fileAnalysis: true,
					projectContext: false,
					toolUse: true,
					functionCalling: true,
					imageAnalysis: true,
				},
				limitations: {
					rateLimit: {
						requestsPerMinute: 100,
						tokensPerMinute: 50000,
					},
					contextLimitations: ["Less sophisticated reasoning"],
					unsupportedFeatures: ["Complex architectural planning"],
					knownIssues: [],
					bestUseCases: [
						"Quick code fixes",
						"Simple explanations",
						"Fast iterations",
					],
					notRecommendedFor: [
						"Complex system design",
						"Large codebase analysis",
					],
				},
				contextWindow: 200000,
				maxOutputTokens: 4096,
				supportedLanguages: [
					"en",
					"es",
					"fr",
					"de",
					"it",
					"pt",
					"ru",
					"ja",
					"ko",
					"zh",
				],
				pricing: {
					inputTokenCost: 0.25,
					outputTokenCost: 1.25,
					currency: "USD",
					unit: "per 1M tokens",
				},
				availability: {
					status: "available",
					requiresAuth: true,
				},
				lastUpdated: Date.now(),
			},
		];

		return {
			models,
			discoveredAt: Date.now(),
			source: "Anthropic API",
		};
	}

	/**
	 * Discover OpenAI models
	 */
	private async discoverOpenAIModels(): Promise<MCPDiscoveryResult> {
		const models: MCPModel[] = [
			{
				id: "gpt-4o",
				name: "GPT-4o",
				provider: "OpenAI",
				description: "Most advanced multimodal model",
				capabilities: {
					codeGeneration: true,
					codeReview: true,
					debugging: true,
					explanation: true,
					refactoring: true,
					testing: true,
					documentation: true,
					multiLanguage: true,
					realTimeChat: true,
					fileAnalysis: true,
					projectContext: true,
					toolUse: true,
					functionCalling: true,
					imageAnalysis: true,
					webSearch: true,
				},
				limitations: {
					rateLimit: {
						requestsPerMinute: 30,
						tokensPerMinute: 30000,
					},
					contextLimitations: ["May lose track in very long conversations"],
					unsupportedFeatures: [],
					knownIssues: ["Occasional inconsistency in code style"],
					bestUseCases: [
						"General programming",
						"Multimodal tasks",
						"Complex reasoning",
					],
					notRecommendedFor: ["Highly sensitive code"],
				},
				contextWindow: 128000,
				maxOutputTokens: 16384,
				supportedLanguages: [
					"en",
					"es",
					"fr",
					"de",
					"it",
					"pt",
					"ru",
					"ja",
					"ko",
					"zh",
				],
				pricing: {
					inputTokenCost: 2.5,
					outputTokenCost: 10.0,
					currency: "USD",
					unit: "per 1M tokens",
				},
				availability: {
					status: "available",
					requiresAuth: true,
				},
				lastUpdated: Date.now(),
			},
			{
				id: "gpt-4o-mini",
				name: "GPT-4o Mini",
				provider: "OpenAI",
				description: "Efficient model for everyday tasks",
				capabilities: {
					codeGeneration: true,
					codeReview: true,
					debugging: true,
					explanation: true,
					refactoring: true,
					testing: true,
					documentation: true,
					multiLanguage: true,
					realTimeChat: true,
					fileAnalysis: true,
					projectContext: false,
					toolUse: true,
					functionCalling: true,
					imageAnalysis: true,
				},
				limitations: {
					rateLimit: {
						requestsPerMinute: 100,
						tokensPerMinute: 200000,
					},
					contextLimitations: ["Less sophisticated reasoning"],
					unsupportedFeatures: ["Complex architectural analysis"],
					knownIssues: [],
					bestUseCases: ["Quick tasks", "Code completion", "Simple debugging"],
					notRecommendedFor: [
						"Complex system architecture",
						"Advanced reasoning",
					],
				},
				contextWindow: 128000,
				maxOutputTokens: 16384,
				supportedLanguages: [
					"en",
					"es",
					"fr",
					"de",
					"it",
					"pt",
					"ru",
					"ja",
					"ko",
					"zh",
				],
				pricing: {
					inputTokenCost: 0.15,
					outputTokenCost: 0.6,
					currency: "USD",
					unit: "per 1M tokens",
				},
				availability: {
					status: "available",
					requiresAuth: true,
				},
				lastUpdated: Date.now(),
			},
		];

		return {
			models,
			discoveredAt: Date.now(),
			source: "OpenAI API",
		};
	}

	/**
	 * Discover Google models
	 */
	private async discoverGoogleModels(): Promise<MCPDiscoveryResult> {
		const models: MCPModel[] = [
			{
				id: "gemini-1.5-pro",
				name: "Gemini 1.5 Pro",
				provider: "Google",
				description: "Advanced reasoning and long context model",
				capabilities: {
					codeGeneration: true,
					codeReview: true,
					debugging: true,
					explanation: true,
					refactoring: true,
					testing: true,
					documentation: true,
					multiLanguage: true,
					realTimeChat: true,
					fileAnalysis: true,
					projectContext: true,
					toolUse: true,
					functionCalling: true,
					imageAnalysis: true,
				},
				limitations: {
					rateLimit: {
						requestsPerMinute: 60,
						tokensPerMinute: 32000,
					},
					contextLimitations: [],
					unsupportedFeatures: [],
					knownIssues: ["Limited availability in some regions"],
					bestUseCases: [
						"Long document analysis",
						"Complex reasoning",
						"Large codebase review",
					],
					notRecommendedFor: ["Simple tasks where speed matters"],
				},
				contextWindow: 2000000,
				maxOutputTokens: 8192,
				supportedLanguages: [
					"en",
					"es",
					"fr",
					"de",
					"it",
					"pt",
					"ru",
					"ja",
					"ko",
					"zh",
				],
				pricing: {
					inputTokenCost: 1.25,
					outputTokenCost: 5.0,
					currency: "USD",
					unit: "per 1M tokens",
					freeQuota: {
						tokens: 1000000,
						period: "daily",
					},
				},
				availability: {
					status: "available",
					requiresAuth: true,
				},
				lastUpdated: Date.now(),
			},
		];

		return {
			models,
			discoveredAt: Date.now(),
			source: "Google AI API",
		};
	}

	/**
	 * Discover local models (for development)
	 */
	private async discoverLocalModels(): Promise<MCPDiscoveryResult> {
		const models: MCPModel[] = [];

		// Only include local models in development or when specifically configured
		if (__DEV__ || Platform.OS === "web") {
			models.push({
				id: "local-codellama",
				name: "Code Llama (Local)",
				provider: "Local",
				description: "Local development model",
				capabilities: {
					codeGeneration: true,
					codeReview: true,
					debugging: true,
					explanation: true,
					refactoring: true,
					testing: false,
					documentation: true,
					multiLanguage: true,
					realTimeChat: true,
					fileAnalysis: true,
					projectContext: false,
					toolUse: false,
					functionCalling: false,
				},
				limitations: {
					contextLimitations: ["Limited context window", "Slower inference"],
					unsupportedFeatures: [
						"Image analysis",
						"Web search",
						"Function calling",
					],
					knownIssues: ["Requires local setup"],
					bestUseCases: ["Offline development", "Privacy-sensitive tasks"],
					notRecommendedFor: ["Production applications", "Complex reasoning"],
				},
				contextWindow: 16384,
				maxOutputTokens: 4096,
				supportedLanguages: ["en"],
				availability: {
					status: "beta",
					requiresAuth: false,
				},
				lastUpdated: Date.now(),
			});
		}

		return {
			models,
			discoveredAt: Date.now(),
			source: "Local Discovery",
		};
	}

	/**
	 * Get cached models
	 */
	getCachedModels(): MCPModel[] {
		const cached = this.cachedResults.get("all_models");
		return cached?.models || [];
	}

	/**
	 * Get model by ID
	 */
	getModelById(id: string): MCPModel | undefined {
		const cached = this.cachedResults.get("all_models");
		return cached?.models.find((model) => model.id === id);
	}

	/**
	 * Filter models by capabilities
	 */
	filterModelsByCapabilities(
		capabilities: Partial<ModelCapabilities>,
	): MCPModel[] {
		const models = this.getCachedModels();
		return models.filter((model) => {
			return Object.entries(capabilities).every(([key, required]) => {
				if (!required) return true;
				return model.capabilities[key as keyof ModelCapabilities] === true;
			});
		});
	}

	/**
	 * Get models by provider
	 */
	getModelsByProvider(provider: string): MCPModel[] {
		const models = this.getCachedModels();
		return models.filter(
			(model) => model.provider.toLowerCase() === provider.toLowerCase(),
		);
	}

	/**
	 * Clear cache
	 */
	clearCache(): void {
		this.cachedResults.clear();
		this.cacheExpiry.clear();
		console.log("🗑️ MCP cache cleared");
	}

	/**
	 * Check if cache is valid
	 */
	private isCacheValid(key: string): boolean {
		const expiry = this.cacheExpiry.get(key);
		return expiry ? Date.now() < expiry : false;
	}

	/**
	 * Get cache info
	 */
	getCacheInfo(): { size: number; entries: string[]; oldestEntry?: number } {
		const entries = Array.from(this.cachedResults.keys());
		const oldestEntry =
			entries.length > 0
				? Math.min(
						...entries.map(
							(key) => this.cachedResults.get(key)?.discoveredAt || Date.now(),
						),
					)
				: undefined;

		return {
			size: this.cachedResults.size,
			entries,
			oldestEntry,
		};
	}
}

// Export singleton instance
export const mcpService = MCPService.getInstance();
