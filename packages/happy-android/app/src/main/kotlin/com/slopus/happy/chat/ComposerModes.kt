package com.slopus.happy.chat

import androidx.compose.runtime.Immutable
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.isRig
import com.slopus.happy.model.isRigV1
import com.slopus.happy.model.qualifyRigModelKey
import com.slopus.happy.model.rigComposerMode
import com.slopus.happy.model.rigModels
import com.slopus.happy.model.rigSelectedModel
import com.slopus.happy.model.settings.AgentDefaultField
import com.slopus.happy.model.settings.AgentDefaultOverrides
import com.slopus.happy.model.settings.AgentDefaults
import com.slopus.happy.model.settings.ModeOption
import com.slopus.happy.model.settings.ModeOptions
import com.slopus.happy.sync.AgentModeField
import com.slopus.happy.sync.ComposerMirror

/**
 * useComposerModes.ts `ComposerModes`: what the composer's permission, model
 * and effort chips list and show. The `can*` flags are rig.ts's
 * `isRig*SelectionEnabled`: a Happy Agent session may lock a picker.
 */
@Immutable
data class ComposerModes(
    val availableModes: List<ModeOption> = emptyList(),
    val permissionMode: ModeOption? = null,
    val availableModels: List<ModeOption> = emptyList(),
    val modelMode: ModeOption? = null,
    val availableEffortLevels: List<ModeOption> = emptyList(),
    val effortLevel: ModeOption? = null,
    val canChangePermission: Boolean = false,
    val canChangeModel: Boolean = false,
    val canChangeEffort: Boolean = false,
) {
    companion object {
        val None = ComposerModes()
    }
}

/** rig.ts `isRigModelSelectionEnabled` */
fun SessionMetadata?.rigModelSelectionEnabled(): Boolean =
    !isRigV1() || (this?.session?.modelLocked != true && this?.capabilities?.modelSelection != false)

/** rig.ts `isRigReasoningSelectionEnabled` */
fun SessionMetadata?.rigReasoningSelectionEnabled(): Boolean = !isRigV1() || this?.capabilities?.reasoningSelection != false

/** rig.ts `isRigPermissionSelectionEnabled` */
fun SessionMetadata?.rigPermissionSelectionEnabled(): Boolean = !isRigV1() || this?.capabilities?.permissionModeSelection != false

object ComposerModeResolver {
    /**
     * useComposerModes: each chip's value is the session's own pick
     * ([mirror]) when the list has it, then, for a Happy Agent session,
     * what the agent reports; for any other, the user's agent default and
     * then what the agent reports. A pick on a retired Claude row shows the
     * row that runs the same model.
     */
    fun resolve(
        metadata: SessionMetadata?,
        mirror: ComposerMirror,
        overrides: AgentDefaultOverrides?,
        translate: (Int) -> String,
    ): ComposerModes {
        val flavor = metadata?.flavor
        val rig = metadata.isRig()
        val defaults = AgentDefaults.resolve(overrides, flavor, metadata?.version)
        val hasMetadataCatalog = !metadata?.models.isNullOrEmpty()
        val hasExplicitModelOverride = AgentDefaults.hasOverride(overrides, flavor, AgentDefaultField.ModelMode)
        val hasExplicitEffortOverride = AgentDefaults.hasOverride(overrides, flavor, AgentDefaultField.EffortLevel)
        val reportedModel = metadata?.currentModelCode
        val reportedEffort = metadata?.currentThoughtLevelCode
        val sessionModel = if (rig) mirror.modelMode else AgentDefaults.retireModelMode(flavor, mirror.modelMode)
        val fallbackModel = if (hasMetadataCatalog && !hasExplicitModelOverride) (reportedModel ?: defaults.modelMode) else defaults.modelMode
        val models = ModeOptions.availableModels(flavor, metadata, translate, sessionModel ?: if (rig) null else fallbackModel)
        val modes = ModeOptions.availablePermissionModes(flavor, metadata, translate, mirror.permissionMode)
        val permission = ModeOptions.resolveCurrentOption(
            modes,
            if (rig) {
                listOf(mirror.permissionMode, metadata?.currentOperatingModeCode, metadata?.permissionMode, metadata?.session?.permissionMode)
            } else {
                listOf(mirror.permissionMode, defaults.permissionMode, metadata?.currentOperatingModeCode)
            },
        )
        val rigModelKey = metadata.rigSelectedModel()?.let { (provider, id) -> qualifyRigModelKey(provider, id) }
        val model = ModeOptions.resolveCurrentOption(
            models,
            listOf(sessionModel) + if (rig) {
                listOf(rigModelKey)
            } else if (hasMetadataCatalog && !hasExplicitModelOverride) {
                listOf(reportedModel, defaults.modelMode)
            } else {
                listOf(defaults.modelMode, reportedModel)
            },
        )
        val modelKey = model?.key ?: "default"
        val efforts = ModeOptions.effortLevelsForModel(flavor, modelKey, metadata)
        val effort = ModeOptions.resolveCurrentOption(
            efforts,
            listOf(mirror.effortLevel) + if (rig) {
                listOf(rigReasoningSelection(metadata, modelKey, efforts))
            } else if (hasMetadataCatalog && !hasExplicitEffortOverride) {
                listOf(reportedEffort, defaults.effortLevel)
            } else {
                listOf(defaults.effortLevel)
            },
        )
        return ComposerModes(
            availableModes = modes,
            permissionMode = permission,
            availableModels = models,
            modelMode = model,
            availableEffortLevels = efforts,
            effortLevel = effort,
            canChangePermission = metadata.rigPermissionSelectionEnabled(),
            canChangeModel = metadata.rigModelSelectionEnabled(),
            canChangeEffort = metadata.rigReasoningSelectionEnabled(),
        )
    }

    // rig.ts getRigReasoningSelection, against the levels already resolved for the model.
    private fun rigReasoningSelection(metadata: SessionMetadata?, modelKey: String, levels: List<ModeOption>): String? {
        val keys = levels.map { it.key }
        val explicit = metadata.rigComposerMode()?.effort ?: metadata?.reasoning?.current ?: metadata?.currentThoughtLevelCode
        if (explicit != null && explicit in keys) return explicit
        val modelDefault = metadata.rigModels().find { it.key == modelKey }?.defaultThinkingLevel
        return modelDefault?.takeIf { it in keys }
    }

    /**
     * SessionView.tsx's `update*` handlers: only the field picked, except
     * that a model whose levels lack the session's effort pick also resets
     * effort to the model's default (null clears the pick).
     */
    fun patch(field: AgentModeField, option: ModeOption, metadata: SessionMetadata?, mirror: ComposerMirror): Map<AgentModeField, String?> {
        if (field != AgentModeField.MODEL_MODE) return mapOf(field to option.key)
        val effort = mirror.effortLevel ?: return mapOf(field to option.key)
        val levels = ModeOptions.effortLevelsForModel(metadata?.flavor, option.key, metadata)
        if (levels.any { it.key == effort }) return mapOf(field to option.key)
        return mapOf(field to option.key, AgentModeField.EFFORT_LEVEL to option.defaultThinkingLevel)
    }
}
