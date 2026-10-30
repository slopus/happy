package com.slopus.happy.conversation

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.bool
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.chat.strings
import kotlinx.serialization.json.JsonObject

/** One model a provider offers, as `GET /v0/config` defines it. */
@Immutable
data class ModelChoice(
    val providerId: String,
    val providerName: String,
    val providerType: String?,
    val modelId: String,
    val name: String,
    val efforts: List<String>,
    val defaultEffort: String?,
    val serviceTiers: List<String>,
)

/**
 * What a message can run with (API.md `GET /v0/config`): every enabled
 * model of every enabled, shown provider, in the order the daemon lists
 * them, and the mode to use when nothing was picked.
 */
@Immutable
data class ModeCatalog(val models: List<ModelChoice>, val defaults: Mode?) {

    fun model(providerId: String, modelId: String): ModelChoice? =
        models.firstOrNull { it.providerId == providerId && it.modelId == modelId }

    /**
     * [current] on another model. It keeps the effort and service tier
     * the model can run; otherwise the model's default effort and no tier.
     */
    fun pick(current: Mode, providerId: String, modelId: String): Mode {
        val choice = model(providerId, modelId) ?: return current
        return current.copy(
            providerId = providerId,
            modelId = modelId,
            effort = current.effort.takeIf { it in choice.efforts } ?: choice.defaultEffort ?: choice.efforts.firstOrNull() ?: current.effort,
            serviceTier = current.serviceTier?.takeIf { it in choice.serviceTiers },
        )
    }

    companion object {
        /** The four permission modes, least to most trusted (permissions-and-sandbox.md). */
        val PERMISSION_MODES = listOf("read_only", "workspace_write", "auto", "full_access")

        fun parse(config: JsonObject): ModeCatalog {
            val root = config["config"].obj ?: config
            val definitions = root["models"].obj
            val models = ArrayList<ModelChoice>()
            root["providers"].obj?.forEach { (providerId, value) ->
                val provider = value.obj ?: return@forEach
                if (provider["enabled"].bool == false || provider["hidden"].bool == true) return@forEach
                val type = provider["type"].str
                val providerName = provider["name"].str?.takeIf { it.isNotBlank() } ?: providerName(type ?: providerId)
                provider["models"].arr?.forEach models@{ entry ->
                    val ref = entry.obj ?: return@models
                    val modelId = ref["id"].str ?: return@models
                    if (ref["enabled"].bool == false) return@models
                    val definition = definitions?.get(modelId).obj
                    models += ModelChoice(
                        providerId = providerId,
                        providerName = providerName,
                        providerType = type,
                        modelId = modelId,
                        name = definition?.get("name").str ?: modelId,
                        efforts = definition?.get("efforts").strings.orEmpty(),
                        defaultEffort = definition?.get("defaultEffort").str,
                        serviceTiers = definition?.get("serviceTiers").strings.orEmpty(),
                    )
                }
            }
            return ModeCatalog(models, ConversationApi.defaultModeOf(config))
        }

        private fun providerName(type: String): String = when (type) {
            "claude" -> "Claude"
            "codex" -> "Codex"
            "grok" -> "Grok"
            "kimi" -> "Kimi"
            else -> type.replaceFirstChar { it.uppercaseChar() }
        }
    }
}
