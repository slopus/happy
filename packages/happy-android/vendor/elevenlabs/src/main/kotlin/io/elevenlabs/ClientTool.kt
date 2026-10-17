package io.elevenlabs

/**
 * Interface for client-side tools that can be executed by ElevenLabs agents
 *
 * Client tools allow agents to trigger custom functionality in your application,
 * such as accessing device capabilities, updating UI, or calling external APIs.
 */
interface ClientTool {
    /**
     * Execute the tool with the provided parameters
     *
     * @param parameters Map of parameter names to values provided by the agent
     * @return Result of the tool execution, or null if no response should be sent
     */
    suspend fun execute(parameters: Map<String, Any>): ClientToolResult?
}

/**
 * Result of a client tool execution
 *
 * @param success Whether the tool executed successfully
 * @param result The result data or message from the tool execution
 * @param error Error message if the execution failed (null if successful)
 */
data class ClientToolResult(
    val success: Boolean,
    val result: String,
    val error: String? = null
) {
    companion object {
        /**
         * Create a successful result
         */
        fun success(result: String) = ClientToolResult(
            success = true,
            result = result
        )

        /**
         * Create a failure result
         */
        fun failure(error: String) = ClientToolResult(
            success = false,
            result = "",
            error = error
        )
    }
}