package io.elevenlabs

import org.json.JSONObject

/**
 * Helper to construct the initiation client data payload from ConversationConfig.
 */
object ConversationOverridesBuilder {

    private const val TYPE = "conversation_initiation_client_data"

    fun constructOverrides(config: ConversationConfig): JSONObject {
        val root = JSONObject().put("type", TYPE)

        // conversation_config_override
        config.overrides?.let { ovr ->
            val overrideObj = JSONObject()

            // agent
            val agentObj = JSONObject()
            ovr.agent?.let { agent ->
                agent.prompt?.let { prompt ->
                    val promptObj = JSONObject().put("prompt", prompt.prompt)
                    agentObj.put("prompt", promptObj)
                }
                agent.firstMessage?.let { agentObj.put("first_message", it) }
                agent.language?.let { agentObj.put("language", it.code) }
            }
            if (agentObj.length() > 0) overrideObj.put("agent", agentObj)

            // tts
            val ttsObj = JSONObject()
            ovr.tts?.voiceId?.let { ttsObj.put("voice_id", it) }
            if (ttsObj.length() > 0) overrideObj.put("tts", ttsObj)

            // conversation
            val convObj = JSONObject()
            ovr.conversation?.textOnly?.let { convObj.put("text_only", it) }
            if (convObj.length() > 0) overrideObj.put("conversation", convObj)

            if (overrideObj.length() > 0) {
                root.put("conversation_config_override", overrideObj)
            }
        }

        // custom_llm_extra_body
        config.customLlmExtraBody?.let { map ->
            root.put("custom_llm_extra_body", JSONObject(map))
        }

        // dynamic_variables
        config.dynamicVariables?.let { map ->
            root.put("dynamic_variables", JSONObject(map))
        }

        // user_id
        config.userId?.let { root.put("user_id", it) }

        // source_info
        config.overrides?.client?.let { c ->
            val src = JSONObject()
            c.source?.let { src.put("source", it) }
            c.version?.let { src.put("version", it) }
            if (src.length() > 0) root.put("source_info", src)
        }

        return root
    }
}

