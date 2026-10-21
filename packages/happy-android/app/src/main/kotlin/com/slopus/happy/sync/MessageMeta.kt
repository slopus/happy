package com.slopus.happy.sync

import com.slopus.happy.model.AgentAttention
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.SessionState
import com.slopus.happy.model.isRigV1
import com.slopus.happy.model.qualifyRigModelKey
import com.slopus.happy.model.resolveSessionState
import com.slopus.happy.model.rigComposerMode
import com.slopus.happy.model.rigCurrentModel
import com.slopus.happy.model.rigModels
import com.slopus.happy.model.rigSelectedModel
import com.slopus.happy.model.settings.AgentDefaultOverrides
import com.slopus.happy.model.settings.AgentDefaults
import com.slopus.happy.model.settings.Versions

/**
 * The session or a saved default carries a permission mode the session's CLI
 * cannot parse (messageMeta.ts). Refused rather than substituted: swapping in
 * another mode would silently change what the agent may do.
 */
class UnsupportedPermissionModeException(val mode: String, val cliVersion: String) : IllegalStateException(
    "This session's Happy CLI (v$cliVersion) does not support the '$mode' permission mode. " +
        "Pick a different mode for this session, or update the Happy CLI on that machine.",
)

/** messageMeta.ts: the meta a sent message carries about delivery and the picks it runs with. */
object MessageMetaResolver {
    /** modelModeOptions.ts `PERMISSION_MODE_SINCE_CLI_VERSION` */
    private val permissionModeSinceCli = mapOf("auto" to AgentDefaults.CLI_VERSION_WITH_AUTO)

    /**
     * modelModeOptions.ts `permissionModeSupportedByCli`. No version is
     * permissive (not happy-cli); an unparseable one hides tagged modes.
     */
    fun permissionModeSupportedByCli(mode: String?, cliVersion: String?): Boolean {
        if (mode.isNullOrEmpty()) return true
        val since = permissionModeSinceCli[mode] ?: return true
        if (cliVersion.isNullOrEmpty()) return true
        if (!Versions.isWellFormed(cliVersion)) return false
        return Versions.compareWithPrerelease(cliVersion, since) >= 0
    }

    /** messageMeta.ts `resolveMessageDeliveryMeta`: only for a session that sends acceptance receipts. */
    fun delivery(
        metadata: SessionMetadata?,
        agentStateJson: String?,
        thinking: Boolean,
        isNewSession: Boolean,
        hasPendingUserMessage: Boolean,
    ): MessageDeliveryMeta {
        if (!metadata.rigSendsMessageReceipts()) return MessageDeliveryMeta()
        // Connectivity is ignored: being offline alone does not mean another turn
        // holds the agent. A pending question waits for this very answer.
        val state = resolveSessionState(AgentAttention.parse(agentStateJson), thinking, isOnline = true)
        return MessageDeliveryMeta(
            expectsAcceptance = true,
            queuedWhileBusy = !isNewSession &&
                (hasPendingUserMessage || state == SessionState.Thinking || state == SessionState.PermissionRequired),
        )
    }

    /**
     * messageMeta.ts `resolveMessageModeMeta`: the composer's picks ([mirror]),
     * falling back to the agent defaults the composer displays.
     *
     * @throws UnsupportedPermissionModeException
     */
    fun mode(metadata: SessionMetadata?, mirror: ComposerMirror, overrides: AgentDefaultOverrides?): MessageModeMeta {
        if (metadata.isRigV1()) return rigMode(metadata!!, mirror)

        val flavor = metadata?.flavor
        val agentOverrides = AgentDefaults.override(overrides, flavor)
        val cliVersion = metadata?.version
        fun supported(mode: String?): String? {
            if (mode != null && !permissionModeSupportedByCli(mode, cliVersion)) {
                throw UnsupportedPermissionModeException(mode, cliVersion ?: "unknown")
            }
            return mode
        }

        // Codex and Agy always run with a concrete permission, model and effort:
        // send what the composer shows rather than leaving the agent to guess.
        if (flavor == "codex" || flavor == "agy") {
            val defaults = AgentDefaults.resolve(overrides, flavor, cliVersion)
            val modelMode = mirror.modelMode ?: defaults.modelMode
            return MessageModeMeta(
                permissionMode = supported(AgentDefaults.retirePermissionMode(mirror.permissionMode ?: defaults.permissionMode)),
                model = Present(modelMode.takeUnless { it == "default" }),
                effort = Present(mirror.effortLevel ?: defaults.effortLevel),
            )
        }

        val permissionMode = when {
            mirror.permissionMode != null -> supported(AgentDefaults.retirePermissionMode(mirror.permissionMode))
            agentOverrides.permissionMode != null -> supported(agentOverrides.permissionMode)
            else -> null
        }
        val modelMode = mirror.modelMode ?: agentOverrides.modelMode
        val effort = mirror.effortLevel ?: agentOverrides.effortLevel
        return MessageModeMeta(
            permissionMode = permissionMode,
            model = modelMode?.let { Present(it.takeUnless { mode -> mode == "default" }) },
            effort = effort?.let { Present(it) },
        )
    }

    /** Happy Agent: the composer mirror (draft, then lastMode), the deprecated display fields only last. */
    private fun rigMode(metadata: SessionMetadata, mirror: ComposerMirror): MessageModeMeta {
        val composerMode = metadata.rigComposerMode()
        val permissionMode = mirror.permissionMode
            ?: composerMode?.permissionMode
            ?: metadata.currentOperatingModeCode
            ?: metadata.permissionMode
            ?: metadata.session?.permissionMode
        val serviceTier = when {
            mirror.hasServiceTier -> Present(mirror.serviceTier)
            composerMode != null -> Present(composerMode.serviceTier)
            else -> null
        }
        val sessionKey = metadata.rigSelectedModel()?.let { (provider, id) -> qualifyRigModelKey(provider, id) }
        val selectedKey = mirror.modelMode ?: sessionKey
        val selected = metadata.rigModels().find { it.key == selectedKey }
            ?: if (selectedKey == sessionKey) metadata.rigCurrentModel() else null
        var model: Present<String>? = null
        var providerId: String? = null
        if (selected != null) {
            model = Present(selected.id)
            providerId = selected.providerId
        } else if (selectedKey != null && ':' in selectedKey) {
            providerId = selectedKey.substringBefore(':')
            model = Present(selectedKey.substringAfter(':'))
        }
        val levels = metadata.rigReasoningLevels(selectedKey)
        val effort = mirror.effortLevel?.takeIf { it.isNotEmpty() && it in levels } ?: metadata.rigReasoningSelection(selectedKey)
        return MessageModeMeta(
            permissionMode = permissionMode?.takeIf { it.isNotEmpty() },
            model = model,
            modelProviderId = providerId,
            effort = effort?.takeIf { it.isNotEmpty() }?.let { Present(it) },
            serviceTier = serviceTier,
        )
    }
}
