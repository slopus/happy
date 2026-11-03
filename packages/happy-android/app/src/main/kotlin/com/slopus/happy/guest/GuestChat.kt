package com.slopus.happy.guest

import androidx.compose.runtime.Immutable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.UUID

/** What the guest screen's line under the title says; the screen words it. */
enum class GuestStatus {
    Invalid, Opening, OpenFailed, EnterName, NameInvalid, Joining, Connecting, Live, BotOffline, ReadOnly,
    NotConfirmed, ConnectionLost, Sending, TooLong, LimitReached, Rejected, ReportSent, ReportFailed,
    InviteFull, Expired, Revoked, AlreadyUsed, Left, RemoveFailed,
}

@Immutable
data class GuestChatState(
    /** The bot's name once joined; null titles the screen Happy. */
    val botName: String? = null,
    val status: GuestStatus? = null,
    /** Asking for the guest's name; [name] is what to show in its field. */
    val naming: Boolean = false,
    val name: String = "",
    /** A join or an opening is under way. */
    val busy: Boolean = false,
    val joined: Boolean = false,
    val displayName: String? = null,
    val lines: List<GuestLine> = emptyList(),
    /** The composer's text, restored from an unconfirmed message. */
    val draft: String = "",
    val readOnly: Boolean = false,
    val sending: Boolean = false,
    /** A message is waiting to be confirmed: the field holds still until it is. */
    val pending: Boolean = false,
    val retry: Boolean = false,
    /** Access ended or the link is no good: nothing more to do here. */
    val ended: Boolean = false,
)

/**
 * The guest chat behind an invitation link (happy-ios
 * HappyGuestUI/GuestChatViewController.swift): open the link, ask the
 * guest's name unless a session or a join is kept, join, then follow the
 * chat by long polls and send as the guest. It never touches an owner
 * credential. Polling runs only while the screen is [setActive].
 */
class GuestChat(
    private val vault: GuestSessionVault,
    private val scope: CoroutineScope,
    private val makeClient: (String) -> GuestClient = { GuestClient(it) },
    /** Where the bridge for an invitation's origin answers: its own origin, but for a debug build's local bridge. */
    private val apiOrigin: (String) -> String = { it },
) {
    private val stateFlow = MutableStateFlow(GuestChatState())
    val state: StateFlow<GuestChatState> = stateFlow.asStateFlow()

    private var invitation: GuestInvitation? = null
    private var naming: GuestInvitation? = null
    private var record: StoredGuestSession? = null
    private var client: GuestClient? = null
    private var cursor: String? = null
    private var opening: Job? = null
    private var polling: Job? = null
    private var sendingJob: Job? = null
    private var generation = 0
    private var active = true
    private var terminal = false
    private var forcedReadOnly = false
    private var noticeUntil = 0L

    private val readOnly get() = forcedReadOnly || record?.readOnlyOverride == true || record?.session?.readOnly == true

    fun open(url: String) {
        val invitation = GuestInvitation.parse(url)
        if (invitation == null) {
            reset()
            terminal = true
            publish(GuestStatus.Invalid)
            return
        }
        if (this.invitation?.identifier == invitation.identifier && !terminal) return setActive(true)
        reset()
        this.invitation = invitation
        val generation = generation
        val origin = apiOrigin(invitation.origin)
        publish(GuestStatus.Opening)
        opening = scope.launch {
            try {
                val stored = vault.restore(invitation.identifier)?.takeIf { it.origin == origin }
                val pending = if (stored == null) vault.pendingRedemption(invitation.identifier) else null
                if (this@GuestChat.generation != generation) return@launch
                opening = null
                when {
                    stored != null -> {
                        vault.save(stored)
                        if (this@GuestChat.generation == generation) apply(stored)
                    }
                    pending != null && pending.nameRejected != true && pending.displayName != null -> redeem(invitation, pending.displayName)
                    else -> {
                        naming = invitation
                        publish(GuestStatus.EnterName)
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                if (this@GuestChat.generation != generation) return@launch
                opening = null
                publish(GuestStatus.OpenFailed, retry = true)
            }
        }
        publish(GuestStatus.Opening)
    }

    fun join(name: String) {
        val invitation = naming ?: return
        if (opening != null) return
        val normalized = GuestDisplayName.normalized(name)
        if (normalized == null) {
            stateFlow.update { it.copy(name = name) }
            publish(GuestStatus.NameInvalid)
            return
        }
        stateFlow.update { it.copy(name = normalized) }
        redeem(invitation, normalized)
    }

    private fun redeem(invitation: GuestInvitation, displayName: String) {
        val generation = generation
        val origin = apiOrigin(invitation.origin)
        stateFlow.update { it.copy(name = displayName) }
        opening = scope.launch {
            var backoff = 1.0
            while (isActive) {
                try {
                    // The vault owns the join, whatever happens to this screen.
                    val stored = vault.redeem(invitation, origin, displayName)
                    if (this@GuestChat.generation != generation) return@launch
                    vault.save(stored)
                    if (this@GuestChat.generation != generation) return@launch
                    opening = null
                    apply(stored)
                    return@launch
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if (this@GuestChat.generation != generation) return@launch
                    if (e == GuestError.InvalidName) naming = invitation
                    if (handle(e)) return@launch
                    if (!active) {
                        opening = null
                        publish(GuestStatus.Joining)
                        return@launch
                    }
                    val wait = (e as? GuestError.RetryAfter)?.seconds ?: backoff.also { backoff = minOf(30.0, backoff * 2) }
                    delay((wait * 1000).toLong())
                }
            }
        }
        publish(GuestStatus.Joining)
    }

    private fun apply(stored: StoredGuestSession) {
        record = stored
        naming = null
        client = makeClient(stored.origin)
        stateFlow.update { it.copy(botName = stored.session.botName, displayName = stored.displayName, draft = stored.pending?.text.orEmpty()) }
        publish(if (readOnly) GuestStatus.ReadOnly else GuestStatus.Connecting)
        connect()
    }

    /** The screen is on (true) or gone or in the background (false): polling follows. */
    fun setActive(active: Boolean) {
        this.active = active
        if (!active) {
            polling?.cancel()
            polling = null
            return
        }
        val invitation = invitation
        if (record == null && opening == null && naming == null && invitation != null && !terminal) open(invitation.url) else connect()
    }

    private fun connect() {
        val client = client ?: return
        val session = record?.session ?: return
        if (!active || terminal || polling != null) return
        val generation = generation
        lateinit var job: Job
        job = scope.launch(start = kotlinx.coroutines.CoroutineStart.LAZY) {
            try {
                var backoff = 1.0
                while (isActive) {
                    try {
                        val page = client.messages(session, cursor)
                        if (this@GuestChat.generation != generation || terminal) return@launch
                        val added = client.append(page.messages, session.botName)
                        cursor = page.cursor
                        if (added.isNotEmpty()) stateFlow.update { it.copy(lines = it.lines + added) }
                        if (System.currentTimeMillis() >= noticeUntil) {
                            publish(
                                when {
                                    readOnly -> GuestStatus.ReadOnly
                                    record?.pending != null -> GuestStatus.NotConfirmed
                                    page.status == "offline" -> GuestStatus.BotOffline
                                    else -> GuestStatus.Live
                                },
                            )
                        }
                        stateFlow.update { it.copy(retry = record?.pending != null) }
                        backoff = 1.0
                        // A bridge that answers at once with nothing still gets a bounded cadence.
                        if (page.messages.isEmpty()) delay(if (page.status == "offline") 4_000 else 1_000)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        if (this@GuestChat.generation != generation) return@launch
                        if (handle(e)) return@launch
                        val wait = (e as? GuestError.RetryAfter)?.seconds ?: backoff.also { backoff = minOf(30.0, backoff * 2) }
                        delay((wait * 1000).toLong())
                    }
                }
            } finally {
                if (polling === job) polling = null
            }
        }
        polling = job
        job.start()
    }

    fun reconnect() {
        if (record?.pending != null) send(stateFlow.value.draft)
        else if (record == null && opening == null) invitation?.let { open(it.url) }
        connect()
    }

    fun draft(text: String) = stateFlow.update { it.copy(draft = text) }

    fun send(text: String) {
        val client = client ?: return
        var stored = record ?: return
        if (sendingJob != null || !active || terminal || readOnly) return
        val trimmed = text.trim()
        if (stored.pending == null && trimmed.isEmpty()) return
        if (trimmed.length > GuestClient.MESSAGE_LIMIT) return notice(GuestStatus.TooLong)
        if (stored.pending == null) stored = stored.copy(pending = GuestPendingMessage(UUID.randomUUID().toString(), trimmed))
        val pending = stored.pending ?: return
        record = stored
        val generation = generation
        sendingJob = scope.launch {
            try {
                vault.save(stored, select = false)
                if (this@GuestChat.generation != generation || terminal) return@launch
                client.send(stored.session, pending.localId, pending.text)
                val acknowledged = stored.copy(pending = null)
                vault.save(acknowledged, select = false)
                if (this@GuestChat.generation != generation || terminal) return@launch
                record = acknowledged
                stateFlow.update { it.copy(draft = "", retry = false) }
                publish(if (readOnly) GuestStatus.ReadOnly else GuestStatus.Live)
                connect()
            } catch (e: CancellationException) {
                throw e
            } catch (e: GuestSendRejection) {
                if (this@GuestChat.generation != generation) return@launch
                stored = stored.copy(pending = null, readOnlyOverride = if (e == GuestSendRejection.LimitReached) true else stored.readOnlyOverride)
                try {
                    vault.save(stored, select = false)
                } catch (_: Exception) {
                }
                if (this@GuestChat.generation != generation) return@launch
                record = stored
                notice(if (e == GuestSendRejection.LimitReached) GuestStatus.LimitReached else GuestStatus.Rejected)
            } catch (e: Exception) {
                if (this@GuestChat.generation == generation) handle(e)
            } finally {
                if (this@GuestChat.generation == generation) {
                    sendingJob = null
                    publish(stateFlow.value.status)
                }
            }
        }
        publish(GuestStatus.Sending)
    }

    fun report() {
        val client = client ?: return
        val session = record?.session ?: return
        val generation = generation
        scope.launch {
            try {
                client.report(session)
                if (this@GuestChat.generation == generation) notice(GuestStatus.ReportSent)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                if (this@GuestChat.generation == generation) publish(GuestStatus.ReportFailed)
            }
        }
    }

    /** Leaves for good: the bridge revokes this guest's session, then it is wiped here. */
    fun leave() {
        val client = client ?: return
        val session = record?.session ?: return
        val generation = generation
        scope.launch {
            try {
                client.block(session)
                if (this@GuestChat.generation == generation) terminate(GuestStatus.Left)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (this@GuestChat.generation == generation) handle(e)
            }
        }
    }

    /** True when [error] ended what was under way for good. */
    private suspend fun handle(error: Exception): Boolean {
        val generation = generation
        when (error) {
            GuestError.InviteFull -> terminate(GuestStatus.InviteFull)
            GuestError.Expired -> terminate(GuestStatus.Expired)
            GuestError.Revoked -> terminate(GuestStatus.Revoked)
            GuestError.AlreadyRedeemed -> terminate(GuestStatus.AlreadyUsed)
            GuestError.InvalidName -> {
                opening = null
                publish(GuestStatus.NameInvalid)
            }
            GuestError.ReadOnly -> {
                forcedReadOnly = true
                record = record?.copy(pending = null, readOnlyOverride = true)
                record?.let {
                    try {
                        vault.save(it, select = false)
                    } catch (_: Exception) {
                    }
                }
                if (this.generation == generation) publish(GuestStatus.ReadOnly)
                return false
            }
            else -> {
                publish(if (record?.pending == null) GuestStatus.ConnectionLost else GuestStatus.NotConfirmed, retry = true)
                return false
            }
        }
        return true
    }

    private suspend fun terminate(status: GuestStatus) {
        val id = invitation?.identifier
        reset()
        val generation = generation
        terminal = true
        publish(status)
        if (id != null) {
            try {
                vault.remove(id)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                if (this.generation == generation) publish(GuestStatus.RemoveFailed)
            }
        }
    }

    private fun reset() {
        generation++
        opening?.cancel()
        opening = null
        polling?.cancel()
        polling = null
        sendingJob?.cancel()
        sendingJob = null
        record = null
        client = null
        cursor = null
        invitation = null
        naming = null
        terminal = false
        forcedReadOnly = false
        noticeUntil = 0
        stateFlow.value = GuestChatState()
    }

    private fun notice(status: GuestStatus) {
        noticeUntil = System.currentTimeMillis() + 5_000
        publish(status)
    }

    /** The state as it now stands, saying [status]. */
    private fun publish(status: GuestStatus?, retry: Boolean? = null) {
        val stored = record
        stateFlow.update {
            it.copy(
                status = status,
                naming = naming != null && !terminal,
                busy = opening != null,
                joined = stored != null,
                readOnly = readOnly,
                sending = sendingJob != null,
                pending = stored?.pending != null,
                retry = retry ?: it.retry,
                ended = terminal,
            )
        }
    }
}
