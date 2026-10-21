package com.slopus.happy.sync

import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.isRig
import com.slopus.happy.model.isRigV1
import com.slopus.happy.model.rigComposerMode
import com.slopus.happy.model.rigHasRpcMethod
import com.slopus.happy.model.rigModels

// rig.ts capability gates. Permissive for everything that is not a v1 Happy
// Agent session: a Happy CLI session answers every method it registers.

/** rig.ts `rigSendsMessageReceipts`: strict, a receipt that never comes would leave a message looking unsent. */
fun SessionMetadata?.rigSendsMessageReceipts(): Boolean = isRigV1() && this?.capabilities?.messageReceipts == true

/** rig.ts `rigCanAbort` */
fun SessionMetadata?.rigCanAbort(): Boolean =
    !isRigV1() || (this?.capabilities?.abort == true && rigHasRpcMethod("abort"))

/** rig.ts `rigCanUseAttachments` */
fun SessionMetadata?.rigCanUseAttachments(): Boolean = !isRigV1() || this?.capabilities?.attachmentsEnabled == true

/** rig.ts `rigCanReadFiles` */
fun SessionMetadata?.rigCanReadFiles(): Boolean =
    !isRigV1() || (this?.capabilities?.filesRead == true && rigHasRpcMethod("readFile"))

/** rig.ts `rigCanBrowseFiles` */
fun SessionMetadata?.rigCanBrowseFiles(): Boolean =
    !isRigV1() || (this?.capabilities?.filesBrowse == true && rigCanReadFiles())

/** rig.ts `rigCanWriteFiles` */
fun SessionMetadata?.rigCanWriteFiles(): Boolean =
    !isRigV1() || (this?.capabilities?.filesWrite == true && rigHasRpcMethod("writeFile"))

/** rig.ts `rigCanSearchFiles` */
fun SessionMetadata?.rigCanSearchFiles(): Boolean =
    !isRigV1() || (this?.capabilities?.filesSearch == true && rigHasRpcMethod("ripgrep"))

/** rig.ts `rigCanUseShell` */
fun SessionMetadata?.rigCanUseShell(): Boolean =
    !isRigV1() || (this?.capabilities?.shell == true && rigHasRpcMethod("bash"))

/** rig.ts `getRigReasoningLevels`: the model's own levels, else the session's. */
fun SessionMetadata?.rigReasoningLevels(modelKey: String?): List<String> {
    if (!isRig()) return emptyList()
    val model = rigModels().find { it.key == modelKey }
    if (model != null && model.thinkingLevels.isNotEmpty()) return model.thinkingLevels
    this?.reasoning?.levels?.takeIf { it.isNotEmpty() }?.let { return it }
    return this?.thoughtLevels.orEmpty().map { it.code }
}

/** rig.ts `getRigReasoningSelection`: the chosen level if the model offers it, else the model's default. */
fun SessionMetadata?.rigReasoningSelection(modelKey: String?): String? {
    if (!isRig()) return null
    val levels = rigReasoningLevels(modelKey)
    val explicit = rigComposerMode()?.effort ?: this?.reasoning?.current ?: this?.currentThoughtLevelCode
    if (explicit != null && explicit in levels) return explicit
    val modelDefault = rigModels().find { it.key == modelKey }?.defaultThinkingLevel
    return if (modelDefault != null && modelDefault in levels) modelDefault else null
}
