package com.slopus.happy.ui.home

import android.content.Context
import android.util.Log
import androidx.compose.foundation.background
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import com.slopus.happy.AppGraph
import com.slopus.happy.BuildConfig
import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.attachments.AttachmentServices
import com.slopus.happy.attachments.AttachmentUploadResult
import com.slopus.happy.attachments.readAttachmentBytes
import com.slopus.happy.model.BOT_FACE_PAINT_SIZE
import com.slopus.happy.model.Machine
import com.slopus.happy.model.Session
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.model.SessionListInputs
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.buildSessionListViewData
import com.slopus.happy.model.worktreeTabSuccessor
import com.slopus.happy.net.HappyHttp
import com.slopus.happy.projects.GitStatusServices
import com.slopus.happy.projects.ProjectServices
import com.slopus.happy.projects.SessionAvatarServices
import com.slopus.happy.resume.SessionResumer
import com.slopus.happy.sync.AccountSync
import com.slopus.happy.sync.MachineOps
import com.slopus.happy.sync.MachinePresence
import com.slopus.happy.sync.OpResult
import com.slopus.happy.sync.SendException
import com.slopus.happy.sync.SendOptions
import com.slopus.happy.sync.SendResult
import com.slopus.happy.sync.SessionPresence
import com.slopus.happy.sync.SyncEngine
import com.slopus.happy.ui.components.confirm
import com.slopus.happy.ui.session.LiveSessionContinuations
import com.slopus.happy.ui.session.SessionContinuations
import com.slopus.happy.ui.session.SessionInfoControls
import java.util.WeakHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.mapLatest
import kotlinx.coroutines.flow.onStart
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * The home screens' long-lived state, one per [AppGraph]: the list derived
 * in the background and kept warm between visits, unread chats, the archive
 * in flight, the store-version check, pending chats, and lazily the
 * new-session composer, the review ask and the bot faces. The draft is reset
 * after a logout wipes the stored data ([AppGraph.afterLogoutWipe]).
 */
class HomeServices private constructor(private val graph: AppGraph) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val account = graph.account
    private val store = graph.store
    private val settings = graph.settings.settings

    val sessionActions: SessionActions = LiveSessionActions { account.value?.sessionOps }
    val archiver = SessionArchiver(sessionActions)

    /** Resume, fork and spawn; null while signed out. */
    val machineOps: MachineOps? get() = account.value?.machineOps

    val continuations: SessionContinuations =
        LiveSessionContinuations({ account.value?.machineOps }, SessionResumer.of(graph)) { SessionResumer.ops(graph) }

    val infoControls: SessionInfoControls = object : SessionInfoControls {
        override suspend fun archive(session: Session): ArchiveResult = archiver.archive(session)

        override suspend fun delete(session: Session): OpResult {
            // Best effort: a running agent would otherwise keep writing into a deleted session.
            if (session.isOnline) sessionActions.kill(session.id)
            return sessionActions.delete(session.id)
        }

        override suspend fun cleanupWorktree(session: Session, confirm: suspend () -> Boolean) = this@HomeServices.cleanupWorktree(session, confirm)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    val snapshots: StateFlow<HomeSnapshot?> = graph.account
        .flatMapLatest { account ->
            homeSnapshots(
                graph.store,
                account?.presence?.sessions ?: flowOf(emptyMap<String, SessionPresence>()),
                account?.presence?.machines ?: flowOf(emptyMap<String, MachinePresence>()),
                // A full session listing has been stored once: every sync after the first.
                synced = (account?.isSyncing ?: flowOf(false))
                    .map { graph.store.cursor(SyncEngine.CURSOR_SESSIONS_LISTED_AT) != null }
                    .flowOn(Dispatchers.IO),
                projects = ProjectServices.of(graph).projects,
                sessionAvatars = SessionAvatarServices.of(graph).avatars,
                gitStatuses = GitStatusServices.of(graph).statuses,
                // storage.ts updateSessionDraft: a blank draft is no draft.
                drafts = account?.composer?.mirrors
                    ?.map { mirrors -> mirrors.mapNotNull { (id, mirror) -> mirror.draft?.takeIf { it.isNotBlank() }?.let { id to it } }.toMap() }
                    ?: flowOf(emptyMap()),
            )
        }
        .stateIn(scope, SharingStarted.Eagerly, null)

    /** Unread chats and the chat on screen ([SessionViewingEffect]); per account, in memory. */
    val reads = SessionReadState()

    val list = HomeListModel(
        snapshots = snapshots,
        settings = graph.settings.settings,
        localSettings = graph.localSettings.values,
        unreadSessionIds = reads.unreadSessionIds,
        archivingSessionIds = archiver.archiving,
        scope = scope,
    )

    private val update = MutableStateFlow<String?>(null)

    /** The store page of a required native update (UpdateBanner's first case). */
    val updateUrl: StateFlow<String?> = update.asStateFlow()

    init {
        graph.afterLogoutWipe { newSessionServices?.resetDraft() }
        scope.launch {
            var account: AccountSync? = null
            graph.account.collect { next -> if (next !== account) { account = next; reads.reset() } }
        }
        scope.launch { snapshots.collect { snapshot -> if (snapshot != null) reads.observe(snapshot.sessions) } }
        scope.launch {
            nativeUpdateChecks(graph.isForeground) { checkNativeUpdate(graph.http, BuildConfig.APPLICATION_ID, BuildConfig.VERSION_NAME) }
                .collect { update.value = it }
        }
    }

    fun session(id: String): Session? = snapshots.value?.sessions?.find { it.id == id }

    fun machine(id: String?): Machine? = id?.let { machineId -> snapshots.value?.machines?.find { it.id == machineId } }

    fun launch(block: suspend CoroutineScope.() -> Unit) = scope.launch(block = block)

    /** maybeCleanupWorktree over the session's machine shell, against the chats active now. */
    suspend fun cleanupWorktree(session: Session, confirm: suspend () -> Boolean) {
        val ops = machineOps ?: return
        val active = snapshots.value?.sessions.orEmpty().filter { it.active }
        maybeCleanupWorktree(session.id, session.metadata?.path, session.metadata?.machineId, active, ops::bash, confirm)
    }

    /** useWorktreeTabSuccessor, read now: the archived chat's neighbouring tab in the project layout. */
    fun tabSuccessor(sessionId: String): String? {
        val grouping = settings.value.sessionListGrouping
        if (grouping != SessionListGrouping.Project) return null
        val snapshot = snapshots.value ?: return null
        val inputs = SessionListInputs(
            snapshot.sessions,
            snapshot.machines.associateBy { it.id },
            snapshot.projects,
            archivingSessionIds = archiver.archiving.value,
            gitStatuses = snapshot.gitStatuses,
        )
        return worktreeTabSuccessor(buildSessionListViewData(inputs), sessionId, grouping)
    }

    private var newSessionServices: NewSessionServices? = null

    /** pendingChats.ts: chats opened from a tab strip's `+` that no machine has answered for yet. */
    val pendingChats = PendingChatStore()

    private val pendingFailures = MutableStateFlow<String?>(null)

    /** A strip start that failed, in its own words, until the screen has shown it. */
    val pendingChatFailure: StateFlow<String?> = pendingFailures.asStateFlow()

    fun dismissPendingChatFailure() {
        pendingFailures.value = null
    }

    val pendingChatHandover = PendingChatHandover(
        pendingChats,
        object : PendingChatSessions {
            override suspend fun send(sessionId: String, text: String): Boolean {
                val sender = account.value?.sender ?: return false
                return when (val result = sender.send(sessionId, text, SendOptions(source = "new_session"))) {
                    is SendResult.Accepted -> true
                    is SendResult.NotSent -> result.message?.let { throw SendException(it) } ?: false
                }
            }

            override fun draft(sessionId: String): String? = account.value?.composer?.mirrors?.value?.get(sessionId)?.draft

            override suspend fun writeDraft(sessionId: String, text: String) {
                account.value?.composer?.setText(sessionId, text)
            }

            override fun exists(sessionId: String): Boolean = session(sessionId) != null

            override fun alert(message: String) {
                pendingFailures.value = message
            }
        },
    )

    /** Where each checkout's tab strip was scrolled to (first item, offset), across the screens that show it. */
    val stripOffsets = java.util.concurrent.ConcurrentHashMap<String, Pair<Int, Int>>()

    private var pendingChatStarter: PendingChatStarter? = null

    /** The tab strip's `+`, starting with the new-session [SessionStarter] one start at a time. */
    @Synchronized
    fun pendingChatStarter(context: Context): PendingChatStarter = pendingChatStarter ?: run {
        val starter = newSession(context).starter
        PendingChatStarter(
            pendingChats,
            pendingChatHandover,
            scope,
            start = { request -> starter.start(request.draft, target = request.target) { false } },
            failed = { pendingFailures.value = it },
        )
    }.also { pendingChatStarter = it }

    /** The new-session composer, its draft in the app's own preferences. */
    @Synchronized
    fun newSession(context: Context): NewSessionServices = newSessionServices ?: run {
        val drafts = NewSessionDraftStore(context.getSharedPreferences(NewSessionDraftStore.PREFS_NAME, Context.MODE_PRIVATE))
        val machineActions = LiveMachineActions { account.value?.machineOps }
        val starter = SessionStarter(
            machines = { snapshots.value?.machines.orEmpty() },
            sessions = { snapshots.value?.sessions.orEmpty() },
            settings = { settings.value },
            drafts = drafts,
            machineActions = machineActions,
            sessionActions = sessionActions,
            sender = LiveFirstMessageSender(
                account = { account.value },
                metadata = { id -> withContext(Dispatchers.IO) { store.session(id)?.metadataJson?.let(SessionMetadata::parse) } },
                upload = { id, images ->
                    AttachmentServices.of(graph).transfers?.upload(id, images, ::readAttachmentBytes) ?: AttachmentUploadResult(emptyList(), images.size)
                },
            ),
            awaitSession = ::awaitSession,
            scope = scope,
            faces = botFaceWearer(context),
        )
        val resources = context.resources
        NewSessionServices(drafts, snapshots, settings, machineActions, starter, newSessionLabels(resources), resources::getString, scope)
    }.also { newSessionServices = it }

    private var reviewPrompter: ReviewPrompter? = null
    private var playStoreReview: PlayStoreReview? = null

    /** requestReview.ts: its stamps in the app's own preferences, its answer in the synced settings. */
    @Synchronized
    fun review(context: Context): Pair<ReviewPrompter, PlayStoreReview> {
        val prompter = reviewPrompter ?: ReviewPrompter(
            answered = { settings.value.let { it.reviewPromptAnswered to it.reviewPromptLikedApp } },
            answer = { liked -> graph.settings.change { it.copy(reviewPromptAnswered = true, reviewPromptLikedApp = liked) } },
            stamps = PrefsReviewStamps(context.getSharedPreferences(PrefsReviewStamps.PREFS_NAME, Context.MODE_PRIVATE)),
        ).also { reviewPrompter = it }
        val store = playStoreReview ?: PlayStoreReview(context.applicationContext).also { playStoreReview = it }
        return prompter to store
    }

    private var botFaces: BotFaces? = null

    /** The bundled bot faces, read from the assets once. */
    @Synchronized
    fun botFaces(context: Context): BotFaces = botFaces ?: BotFaces.assets(context.applicationContext).also { botFaces = it }

    /**
     * wearBotFace: painted here, uploaded as the bot's attachment `face.png`,
     * then worn (setAvatar). Each step fails under its own name.
     */
    private fun botFaceWearer(context: Context) = BotFaceWearer { sessionId, seed ->
        val bytes = try {
            botFaces(context).paint(seed)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return@BotFaceWearer BotFaceFailure(BotFaceLeg.Painting, e.message ?: "The face could not be painted.")
        }
        val face = AttachmentPreview("face-$seed", "", BOT_FACE_PAINT_SIZE, BOT_FACE_PAINT_SIZE, "image/png", bytes.size.toLong(), "face.png")
        val uploaded = AttachmentServices.of(graph).transfers?.upload(sessionId, listOf(face)) { bytes }?.uploaded?.singleOrNull()
            ?: return@BotFaceWearer BotFaceFailure(BotFaceLeg.Uploading, "The picture could not be uploaded.")
        val ops = account.value?.sessionOps ?: return@BotFaceWearer BotFaceFailure(BotFaceLeg.Wearing, "Not signed in")
        try {
            ops.setAvatar(sessionId, uploaded.ref, bytes.size.toLong(), "image/png")
            null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.e("HomeServices", "[bot] The face could not be put on the bot: ${e.message}")
            BotFaceFailure(BotFaceLeg.Wearing, e.message ?: "The picture could not be set.")
        }
    }

    /** offerBotFaceRetry's Try again: only the face, on the bot already made. */
    suspend fun retryBotFace(context: Context, sessionId: String, seed: String): BotFaceFailure? = botFaceWearer(context).wear(sessionId, seed)

    /** sync.ts ensureSessionReady: the new session's row in the store, pulled in by a sync if need be. */
    private suspend fun awaitSession(id: String): Boolean {
        suspend fun stored() = withContext(Dispatchers.IO) { store.session(id) != null }
        var attempt = 0
        while (!stored() && attempt < 3) {
            if (attempt > 0) delay(300L * attempt)
            account.value?.let { withTimeoutOrNull(4_000) { it.syncNow() } }
            attempt++
        }
        return stored()
    }

    companion object {
        private val instances = WeakHashMap<AppGraph, HomeServices>()

        @Synchronized
        fun of(graph: AppGraph): HomeServices = instances.getOrPut(graph) { HomeServices(graph) }
    }
}

/**
 * sync.ts's nativeUpdateSync: [check] now, then again on every return to the
 * foreground; a newer check replaces one still running.
 */
@OptIn(ExperimentalCoroutinesApi::class)
fun nativeUpdateChecks(foreground: StateFlow<Boolean>, check: suspend () -> String?): Flow<String?> =
    foreground.drop(1).filter { it }.map { }.onStart { emit(Unit) }.mapLatest { check() }

/**
 * sync.ts fetchNativeUpdate: POST /v1/version with this build; the store
 * URL when the server says an update is required, else null (also on any
 * failure: the banner is a nicety).
 */
suspend fun checkNativeUpdate(http: HappyHttp, appId: String, version: String): String? = try {
    val body = JsonObject(mapOf("platform" to JsonPrimitive("android"), "version" to JsonPrimitive(version), "app_id" to JsonPrimitive(appId)))
    val response = http.post("/v1/version", body, JsonObject.serializer(), JsonObject.serializer())
    val required = response["update_required"]?.jsonPrimitive?.booleanOrNull == true
    response["update_url"]?.jsonPrimitive?.contentOrNull?.takeIf { required && it.isNotEmpty() }
} catch (e: CancellationException) {
    throw e
} catch (_: Exception) {
    null
}
