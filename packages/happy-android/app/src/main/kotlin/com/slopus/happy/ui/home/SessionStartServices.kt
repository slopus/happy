package com.slopus.happy.ui.home

import com.slopus.happy.attachments.AttachmentNotice
import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.attachments.AttachmentUploadResult
import com.slopus.happy.attachments.prepareAttachmentSend
import com.slopus.happy.model.GitWorktree
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.sync.AccountSync
import com.slopus.happy.sync.AgentModeField
import com.slopus.happy.sync.MachineOps
import com.slopus.happy.sync.OpResult
import com.slopus.happy.sync.SendException
import com.slopus.happy.sync.SendOptions
import com.slopus.happy.sync.SendResult
import com.slopus.happy.sync.SpawnSessionOptions
import com.slopus.happy.sync.SpawnSessionResult

/** The machine RPCs a start runs (ops.ts), as [MachineOps] answers them; tests use a fake. */
interface MachineActions {
    suspend fun spawnSession(options: SpawnSessionOptions): SpawnSessionResult
    suspend fun createWorktree(machineId: String, basePath: String): WorktreeOutcome
    suspend fun listWorktrees(machineId: String, basePath: String): List<GitWorktree>
    suspend fun stopSession(machineId: String, sessionId: String): OpResult
}

/** [MachineActions] over the signed-in account's [MachineOps]. */
class LiveMachineActions(private val ops: () -> MachineOps?) : MachineActions {
    override suspend fun spawnSession(options: SpawnSessionOptions): SpawnSessionResult =
        ops()?.spawnSession(options) ?: SpawnSessionResult.Error(SIGNED_OUT)

    override suspend fun createWorktree(machineId: String, basePath: String): WorktreeOutcome {
        val ops = ops() ?: return WorktreeOutcome.Failed(SIGNED_OUT)
        return createWorktree(basePath) { command -> ops.bash(machineId, command, basePath) }
    }

    override suspend fun listWorktrees(machineId: String, basePath: String): List<GitWorktree> {
        val ops = ops() ?: return emptyList()
        return listWorktrees { command -> ops.bash(machineId, command, basePath) }
    }

    override suspend fun stopSession(machineId: String, sessionId: String): OpResult =
        ops()?.stopSession(machineId, sessionId) ?: OpResult(false, SIGNED_OUT)

    private companion object {
        const val SIGNED_OUT = "Not signed in"
    }
}

/** What a first send did: whether it went out, and the alerts it raised on the way (imageUpload.*). */
data class FirstSend(val sent: Boolean, val notices: List<AttachmentNotice> = emptyList())

/** How the first message reaches the new session (ops.ts sessionSetAgentModes, sync.ts sendMessage). */
interface FirstMessageSender {
    /** Pins the picks the session was started with, so the message's meta resolves from them. */
    suspend fun pinModes(sessionId: String, modes: Map<AgentModeField, String?>)

    /**
     * Sent once [text] and the uploaded [attachments] are in the outbox; not
     * sent when [isCurrent] turned false first, or when the agent takes no
     * images and there is nothing else to send.
     * @throws SendException with the user's words when nothing was queued.
     */
    suspend fun send(sessionId: String, text: String, attachments: List<AttachmentPreview>, isCurrent: () -> Boolean): FirstSend
}

/**
 * [FirstMessageSender] over the signed-in account's composer and sender;
 * attachments go through [prepareAttachmentSend] against the new session's
 * [metadata], uploaded with [upload].
 */
class LiveFirstMessageSender(
    private val account: () -> AccountSync?,
    private val metadata: suspend (sessionId: String) -> SessionMetadata? = { null },
    private val upload: suspend (sessionId: String, List<AttachmentPreview>) -> AttachmentUploadResult = { _, list -> AttachmentUploadResult(emptyList(), list.size) },
) : FirstMessageSender {
    override suspend fun pinModes(sessionId: String, modes: Map<AgentModeField, String?>) {
        account()?.composer?.setAgentModes(sessionId, modes)
    }

    override suspend fun send(sessionId: String, text: String, attachments: List<AttachmentPreview>, isCurrent: () -> Boolean): FirstSend {
        val sender = account()?.sender ?: return FirstSend(false)
        val plan = prepareAttachmentSend(metadata(sessionId), text, attachments) { upload(sessionId, it) }
        if (!plan.send || (text.isBlank() && plan.records.isEmpty())) return FirstSend(false, plan.notices)
        return when (val result = sender.send(sessionId, text, SendOptions(source = "new_session", attachments = plan.records, isCurrent = isCurrent))) {
            is SendResult.Accepted -> FirstSend(true, plan.notices)
            is SendResult.NotSent -> result.message?.let { throw SendException(it) } ?: FirstSend(false, plan.notices)
        }
    }
}

/** Which of the bot face's three steps failed (useStartSessionFromDraft's `BotFaceLeg`). */
enum class BotFaceLeg { Painting, Uploading, Wearing }

/** A face the bot could not be given: the bot is fine, and the face can be tried again on it. */
data class BotFaceFailure(val leg: BotFaceLeg, val message: String)

/**
 * wearBotFace: paint the seed's face, put it in the bot's attachments, ask
 * the bot to wear it. Null once it is worn; otherwise the step that failed.
 */
fun interface BotFaceWearer {
    suspend fun wear(sessionId: String, seed: String): BotFaceFailure?
}
