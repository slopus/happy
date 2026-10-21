package io.elevenlabs

import android.util.Log
import kotlinx.coroutines.*
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Registry for managing client-side tools that can be executed by ElevenLabs agents
 *
 * This class provides a comprehensive framework for registering, validating, and executing
 * client tools with proper error handling, timeout management, and async execution.
 */
class ClientToolRegistry {

    private val tools = ConcurrentHashMap<String, ClientTool>()
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    companion object {
        private const val DEFAULT_TIMEOUT_MS = 30_000L // 30 seconds
    }

    /**
     * Register a client tool that can be called by agents
     *
     * @param name Unique identifier for the tool that agents will use
     * @param tool Implementation of the tool functionality
     * @throws IllegalArgumentException if a tool with the same name already exists
     */
    fun registerTool(name: String, tool: ClientTool) {
        require(name.isNotBlank()) { "Tool name cannot be blank" }

        if (tools.containsKey(name)) {
            throw IllegalArgumentException("Tool with name '$name' is already registered")
        }

        tools[name] = tool
        Log.d("ClientToolRegistry", "Registered client tool: $name")
    }

    /**
     * Unregister a previously registered client tool
     *
     * @param name Tool identifier to remove
     * @return true if the tool was removed, false if it wasn't found
     */
    fun unregisterTool(name: String): Boolean {
        val removed = tools.remove(name) != null
        if (removed) {
        Log.d("ClientToolRegistry", "Unregistered client tool: $name")
        }
        return removed
    }

    /**
     * Execute a client tool with the provided parameters
     *
     * @param name Tool name to execute
     * @param parameters Parameters to pass to the tool
     * @param timeoutMs Maximum execution time in milliseconds
     * @return Result of the tool execution
     */
    suspend fun executeTool(
        name: String,
        parameters: Map<String, Any>,
        timeoutMs: Long = DEFAULT_TIMEOUT_MS
    ): ClientToolResult? {
        val tool = tools[name]
            ?: return ClientToolResult.failure("Tool '$name' not found")

        return try {
            withTimeout(timeoutMs) {
                validateParameters(parameters)
                tool.execute(parameters)
            }
        } catch (e: TimeoutCancellationException) {
            ClientToolResult.failure("Tool execution timed out after ${timeoutMs}ms")
        } catch (e: Exception) {
            ClientToolResult.failure("Tool execution failed: ${e.message}")
        }
    }

    /**
     * Execute a tool in the background without waiting for the result
     *
     * @param name Tool name to execute
     * @param parameters Parameters to pass to the tool
     * @param callback Optional callback to receive the result
     */
    fun executeToolAsync(
        name: String,
        parameters: Map<String, Any>,
        callback: ((ClientToolResult?) -> Unit)? = null
    ) {
        scope.launch {
            val result = executeTool(name, parameters)
            callback?.invoke(result)
        }
    }

    /**
     * Get a list of all registered tool names
     *
     * @return List of tool identifiers
     */
    fun getRegisteredTools(): List<String> = tools.keys.toList()

    /**
     * Check if a tool with the given name is registered
     *
     * @param name Tool name to check
     * @return true if the tool is registered
     */
    fun isToolRegistered(name: String): Boolean = tools.containsKey(name)

    /**
     * Get the number of registered tools
     *
     * @return Count of registered tools
     */
    fun getToolCount(): Int = tools.size

    /**
     * Clear all registered tools
     */
    fun clearAllTools() {
        val toolNames = tools.keys.toList()
        tools.clear()
        Log.d("ClientToolRegistry", "Cleared ${toolNames.size} tools: $toolNames")
    }

    /**
     * Validate tool parameters
     *
     * @param parameters Parameters to validate
     * @throws IllegalArgumentException if parameters are invalid
     */
    private fun validateParameters(parameters: Map<String, Any>) {
        // Basic validation - can be extended based on requirements
        if (parameters.size > 100) {
            throw IllegalArgumentException("Too many parameters (max 100)")
        }

        parameters.forEach { (key, value) ->
            if (key.length > 100) {
                throw IllegalArgumentException("Parameter key too long: $key")
            }

            when (value) {
                is String -> {
                    if (value.length > 10_000) {
                        throw IllegalArgumentException("String parameter too long: $key")
                    }
                }
                is Collection<*> -> {
                    if (value.size > 1000) {
                        throw IllegalArgumentException("Collection parameter too large: $key")
                    }
                }
                is Map<*, *> -> {
                    if (value.size > 100) {
                        throw IllegalArgumentException("Map parameter too large: $key")
                    }
                }
            }
        }
    }

    /**
     * Clean up resources when the registry is no longer needed
     */
    fun cleanup() {
        scope.cancel()
        tools.clear()
    }
}

/**
 * Builder class for creating pre-configured tool registries
 */
class ClientToolRegistryBuilder {
    private val registry = ClientToolRegistry()

    /**
     * Add a tool to the registry
     *
     * @param name Tool identifier
     * @param tool Tool implementation
     * @return This builder for chaining
     */
    fun addTool(name: String, tool: ClientTool): ClientToolRegistryBuilder {
        registry.registerTool(name, tool)
        return this
    }

    /**
     * Add a simple function-based tool
     *
     * @param name Tool identifier
     * @param function Function to execute
     * @return This builder for chaining
     */
    fun addTool(name: String, function: suspend (Map<String, Any>) -> String): ClientToolRegistryBuilder {
        registry.registerTool(name, object : ClientTool {
            override suspend fun execute(parameters: Map<String, Any>): ClientToolResult? {
                return try {
                    val result = function(parameters)
                    ClientToolResult.success(result)
                } catch (e: Exception) {
                    ClientToolResult.failure("Function execution failed: ${e.message}")
                }
            }
        })
        return this
    }

    /**
     * Build the configured registry
     *
     * @return Configured ClientToolRegistry
     */
    fun build(): ClientToolRegistry = registry
}
