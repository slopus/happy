package com.slopus.happy.conversation

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.bool
import com.slopus.happy.chat.num
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
 * One account on the computer (`config.providers`), switched off, hidden or
 * not: its switched-on models in the daemon's order, and those of them kept
 * out of the pickers ([hiddenModels]), which a selection on still works.
 */
@Immutable
data class ModeProvider(
    val id: String,
    val name: String?,
    val type: String,
    val enabled: Boolean,
    val hidden: Boolean,
    val models: List<ModelChoice>,
    val hiddenModels: Set<String> = emptySet(),
) {
    /** Switched off, or on with nothing to offer: its models can't be picked. */
    val isDisabled: Boolean get() = !enabled || models.isEmpty()
}

/**
 * What a message can run with (API.md `GET /v0/config`): [models] is every
 * enabled model of every enabled, shown provider, in the order the daemon
 * lists them; [providers] every account as it is, for the pickers
 * ([ModelMenus]); [defined] every model the computer defines, so a selection
 * on an account since removed still names its model; [defaults] the mode to
 * use when nothing was picked.
 */
@Immutable
data class ModeCatalog(
    val models: List<ModelChoice>,
    val defaults: Mode?,
    /** Each defined model's context window by its id: the model's own, whichever account serves it. */
    val windows: Map<String, ContextWindow> = emptyMap(),
    val providers: List<ModeProvider> = providersOf(models),
    val defined: Map<String, ModelChoice> = emptyMap(),
) {
    fun provider(id: String): ModeProvider? = providers.firstOrNull { it.id == id }

    /** The model as its account lists it, whatever the account's state; else as the computer defines it. */
    fun model(providerId: String, modelId: String): ModelChoice? =
        provider(providerId)?.models?.firstOrNull { it.modelId == modelId }
            ?: models.firstOrNull { it.providerId == providerId && it.modelId == modelId }

    /**
     * `happyAgentSelectionModelUpdate`: [current] on another model, on an
     * account that can serve it. Its effort is [effort] when the model runs
     * it (the current one when the model stays), else the model's own
     * default, never one carried over it may not support; a service tier it
     * doesn't offer is dropped. Unchanged when the account can't serve it.
     */
    fun pick(current: Mode, providerId: String, modelId: String, effort: String? = current.effort.takeIf { providerId == current.providerId && modelId == current.modelId }): Mode {
        val provider = provider(providerId)?.takeIf { !it.isDisabled }
        val choice = provider?.models?.firstOrNull { it.modelId == modelId } ?: return current
        return current.copy(
            providerId = providerId,
            modelId = modelId,
            effort = effort?.takeIf { it in choice.efforts || choice.efforts.isEmpty() } ?: choice.defaultEffort ?: choice.efforts.firstOrNull() ?: current.effort,
            serviceTier = current.serviceTier?.takeIf { it in choice.serviceTiers },
        )
    }

    companion object {
        /** The four permission modes, least to most trusted (permissions-and-sandbox.md). */
        val PERMISSION_MODES = listOf("read_only", "workspace_write", "auto", "full_access")

        fun parse(config: JsonObject): ModeCatalog {
            val root = config["config"].obj ?: config
            val definitions = root["models"].obj
            // A reference may say its own name, efforts and tiers; the definition says the rest.
            fun choice(providerId: String, providerName: String, type: String?, modelId: String, ref: JsonObject?): ModelChoice {
                val definition = definitions?.get(modelId).obj
                fun field(key: String) = ref?.get(key) ?: definition?.get(key)
                return ModelChoice(
                    providerId = providerId,
                    providerName = providerName,
                    providerType = type,
                    modelId = modelId,
                    name = field("name").str ?: modelId,
                    efforts = field("efforts").strings.orEmpty(),
                    defaultEffort = field("defaultEffort").str,
                    serviceTiers = field("serviceTiers").strings.orEmpty(),
                )
            }
            val providers = root["providers"].obj?.mapNotNull { (providerId, value) ->
                val provider = value.obj ?: return@mapNotNull null
                val type = provider["type"].str
                val name = provider["name"].str?.takeIf { it.isNotBlank() }
                val shownName = name ?: providerName(type ?: providerId)
                val refs = provider["models"].arr.orEmpty().mapNotNull { it.obj }.filter { it["enabled"].bool != false }
                ModeProvider(
                    id = providerId,
                    name = name,
                    type = type ?: providerId,
                    enabled = provider["enabled"].bool != false,
                    hidden = provider["hidden"].bool ?: false,
                    models = refs.mapNotNull { ref -> ref["id"].str?.let { choice(providerId, shownName, type, it, ref) } },
                    hiddenModels = refs.filter { it["hidden"].bool == true }.mapNotNull { it["id"].str }.toSet(),
                )
            }.orEmpty()
            val models = providers.filter { it.enabled && !it.hidden }.flatMap { it.models }
            val windows = definitions?.mapNotNull { (id, value) ->
                val definition = value.obj ?: return@mapNotNull null
                val window = ContextWindow(definition["contextWindow"].num?.toLong(), definition["autoCompactWindow"].num?.toLong())
                (id to window).takeIf { window.tokens != null }
            }?.toMap().orEmpty()
            val defined = definitions?.keys?.associateWith { choice("", "", null, it, null) }.orEmpty()
            return ModeCatalog(models, ConversationApi.defaultModeOf(config), windows, providers, defined)
        }

        /** One account per provider [models] name, as a catalog made by hand lists them. */
        fun providersOf(models: List<ModelChoice>): List<ModeProvider> =
            models.groupBy { it.providerId }.map { (id, listed) ->
                ModeProvider(id, listed[0].providerName, listed[0].providerType ?: id, enabled = true, hidden = false, models = listed)
            }

        /** The service a provider type names ("Claude", "Codex"), titled when unknown. */
        fun providerName(type: String): String = when (type) {
            "bedrock" -> "Bedrock"
            "claude" -> "Claude"
            "codex" -> "Codex"
            "grok" -> "Grok"
            "kimi" -> "Kimi"
            else -> type.split('_', '-').filter { it.isNotEmpty() }.joinToString(" ") { part -> part.replaceFirstChar { it.uppercaseChar() } }
        }
    }
}
