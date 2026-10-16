package com.slopus.happy.chat.tools

import androidx.annotation.StringRes
import com.slopus.happy.R
import com.slopus.happy.chat.PermissionAnswer
import com.slopus.happy.chat.PermissionDecision
import com.slopus.happy.chat.PermissionStatus
import com.slopus.happy.chat.ToolPermission
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonElement

// PermissionFooter.tsx's buttons: which ones a request offers, what each
// answers, and which one an answered request was answered with.

enum class PermissionChoice { Allow, AllowAllEdits, AllowEverything, AllowForTool, Deny, CodexAllow, CodexAllowForSession, CodexAbort }

/** One footer button. [mode] is the permission mode the session switches to locally once the answer is sent. */
data class PermissionOption(
    val choice: PermissionChoice,
    @StringRes val label: Int,
    val answer: PermissionAnswer,
    val mode: String?,
    val maxLines: Int,
)

/** How an option reads once the request is answered: the one used, the others faded. */
enum class PermissionOptionState { Pending, Selected, Inactive, Plain }

private val EDIT_TOOLS = setOf("Edit", "MultiEdit", "Write", "NotebookEdit")
private val PLAN_TOOLS = setOf("exit_plan_mode", "ExitPlanMode")

/** Codex sessions, and Codex tools in any session, answer with a decision. */
fun usesCodexPermissions(flavor: String?, toolName: String): Boolean = flavor == "codex" || toolName.startsWith("Codex")

/** `Bash(<command>)` for Bash, else the tool's name: what "don't ask again" allows. */
fun permissionToolIdentifier(toolName: String, input: JsonElement?): String {
    val command = input.obj?.get("command").str
    return if (toolName == "Bash" && !command.isNullOrEmpty()) "Bash($command)" else toolName
}

/** `isToolAllowed` */
fun isToolAllowed(toolName: String, input: JsonElement?, allowedTools: List<String>?): Boolean {
    if (allowedTools == null) return false
    if (toolName in allowedTools) return true
    val command = input.obj?.get("command").str
    return toolName == "Bash" && !command.isNullOrEmpty() && "Bash($command)" in allowedTools
}

fun permissionOptions(permission: ToolPermission, toolName: String, input: JsonElement?, flavor: String?): List<PermissionOption> {
    val id = permission.id
    if (usesCodexPermissions(flavor, toolName)) {
        return listOf(
            PermissionOption(PermissionChoice.CodexAllow, R.string.common_yes, PermissionAnswer(id, true, decision = PermissionDecision.Approved), null, 1),
            PermissionOption(
                PermissionChoice.CodexAllowForSession, R.string.codex_permissions_yes_for_session,
                PermissionAnswer(id, true, decision = PermissionDecision.ApprovedForSession), null, 2,
            ),
            PermissionOption(
                PermissionChoice.CodexAbort, R.string.codex_permissions_stop_and_explain,
                PermissionAnswer(id, false, decision = PermissionDecision.Abort), null, 2,
            ),
        )
    }
    val isPlan = toolName in PLAN_TOOLS
    return buildList {
        // Plain plan approval leaves plan mode on the CLI; the local pick follows.
        add(PermissionOption(PermissionChoice.Allow, R.string.common_yes, PermissionAnswer(id, true), if (isPlan) "default" else null, 1))
        if (toolName in EDIT_TOOLS || isPlan) {
            add(
                PermissionOption(
                    PermissionChoice.AllowAllEdits, R.string.claude_permissions_yes_allow_all_edits,
                    PermissionAnswer(id, true, mode = "acceptEdits"), "acceptEdits", 2,
                ),
            )
        }
        if (isPlan) {
            add(
                PermissionOption(
                    PermissionChoice.AllowEverything, R.string.claude_permissions_yes_allow_everything,
                    PermissionAnswer(id, true, mode = "bypassPermissions"), "bypassPermissions", 2,
                ),
            )
        }
        if (toolName.isNotEmpty() && toolName !in EDIT_TOOLS && !isPlan) {
            add(
                PermissionOption(
                    PermissionChoice.AllowForTool, R.string.claude_permissions_yes_for_tool,
                    PermissionAnswer(id, true, allowedTools = listOf(permissionToolIdentifier(toolName, input))), null, 2,
                ),
            )
        }
        add(PermissionOption(PermissionChoice.Deny, R.string.claude_permissions_no_tell_claude, PermissionAnswer(id, false), null, 2))
    }
}

/** Which button an answered request was answered with, from its mode, grants or decision. */
fun answeredChoice(permission: ToolPermission, toolName: String, input: JsonElement?, flavor: String?): PermissionChoice? {
    val approved = permission.status == PermissionStatus.Approved
    val denied = permission.status == PermissionStatus.Denied
    if (usesCodexPermissions(flavor, toolName)) {
        return when {
            approved && permission.decision == PermissionDecision.ApprovedForSession -> PermissionChoice.CodexAllowForSession
            approved && (permission.decision == PermissionDecision.Approved || permission.decision == null) -> PermissionChoice.CodexAllow
            denied && permission.decision == PermissionDecision.Abort -> PermissionChoice.CodexAbort
            else -> null
        }
    }
    val forTool = isToolAllowed(toolName, input, permission.allowedTools)
    return when {
        denied -> PermissionChoice.Deny
        !approved -> null
        permission.mode == "acceptEdits" -> PermissionChoice.AllowAllEdits
        permission.mode == "bypassPermissions" -> PermissionChoice.AllowEverything
        forTool -> PermissionChoice.AllowForTool
        else -> PermissionChoice.Allow
    }
}

/**
 * The state each option is drawn in. Claude: after a denial every approval
 * fades; after any approval Deny fades. Codex: the other two fade, except
 * after a plain denial, which marks none.
 */
fun permissionOptionState(option: PermissionOption, permission: ToolPermission, answered: PermissionChoice?): PermissionOptionState {
    if (permission.status == PermissionStatus.Pending) return PermissionOptionState.Pending
    if (answered == option.choice) return PermissionOptionState.Selected
    val codex = option.choice in setOf(PermissionChoice.CodexAllow, PermissionChoice.CodexAllowForSession, PermissionChoice.CodexAbort)
    return when {
        codex -> if (answered != null) PermissionOptionState.Inactive else PermissionOptionState.Plain
        option.choice == PermissionChoice.Deny -> if (permission.status == PermissionStatus.Approved) PermissionOptionState.Inactive else PermissionOptionState.Plain
        permission.status == PermissionStatus.Denied || answered != null -> PermissionOptionState.Inactive
        else -> PermissionOptionState.Plain
    }
}
