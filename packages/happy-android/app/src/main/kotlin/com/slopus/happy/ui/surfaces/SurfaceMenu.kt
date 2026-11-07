package com.slopus.happy.ui.surfaces

import com.slopus.happy.ui.conversation.refusalText
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.size
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.R
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.agent.SurfaceType
import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.references.ReferenceReader
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.HappyDropdownMenu
import com.slopus.happy.ui.components.HappyMenuItem
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.conversation.ConversationRoute
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** A Surface's 48 dp More target, using the same confirmation and durable leave as home's menu. */
@Composable
fun SurfaceMenu(
    session: AgentSession,
    surfaceId: String,
    onBack: () -> Unit,
    /** Pushes a route; given, the menu offers the Surface's shared chat. */
    open: ((Any) -> Unit)? = null,
    extraItems: @Composable ColumnScope.(close: () -> Unit) -> Unit = {},
) {
    val catalog by session.surfaces.collectAsStateWithLifecycle()
    val surface = catalog[surfaceId] ?: return
    val scope = rememberCoroutineScope()
    var openingChat by remember { mutableStateOf(false) }
    var chatRefused by remember { mutableStateOf<String?>(null) }
    val resources = LocalResources.current
    // Opening the chat made already only reads it; making it is a write.
    val chats = surface.chatAgentId != null || session.permissions.collectAsStateWithLifecycle().value.canWrite
    val items: @Composable ColumnScope.(close: () -> Unit) -> Unit = { close ->
        if (open != null && chats) {
            // Desktop b3204bde: the one chat everyone in the Surface shares, made the first time anyone opens it.
            HappyMenuItem(
                stringResource(R.string.surface_chat),
                onClick = {
                    close()
                    openingChat = true
                    scope.launch {
                        try {
                            open(ConversationRoute(session.connectionId, session.ensureSurfaceChat(surfaceId)))
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: AgentConnectionException) {
                            chatRefused = resources.getString(e.reason.text)
                        } catch (e: Exception) {
                            chatRefused = e.message.orEmpty()
                        } finally {
                            openingChat = false
                        }
                    }
                },
                enabled = !openingChat,
            )
        }
        extraItems(close)
    }
    chatRefused?.let { reason ->
        HappyAlert(
            Alert(
                title = stringResource(R.string.surface_chat_failed),
                message = reason.ifEmpty { null },
                buttons = listOf(AlertButton(stringResource(R.string.common_ok))),
            ),
            onDismiss = { chatRefused = null },
        )
    }
    // Who is in it and who made it, by name once the computer says them (desktop's `HappyAgentSurfaceHeader`).
    val ids = remember(surface.members, surface.creatorUserId) {
        (surface.members.mapNotNull { it.userId } + listOfNotNull(surface.creatorUserId)).distinct()
    }
    val names by produceState(emptyMap<String, String>(), session, ids) {
        value = try { ReferenceReader.userNames(session.client, ids) } catch (e: CancellationException) { throw e } catch (_: Exception) { emptyMap() }
    }
    val people = SurfacePeople(
        members = surface.members.map { member -> member.userId?.let { names[it] }?.takeIf { it.isNotEmpty() } },
        creator = surface.creatorUserId?.let { names[it] }?.takeIf { it.isNotEmpty() },
        added = surface.type == SurfaceType.ARTIFACT || surface.type == SurfaceType.BOT || surface.type == SurfaceType.TASK,
    )
    SurfaceLeaveMenu(surface.name, onBack, items, people) { session.leaveSurface(surfaceId) }
}

/**
 * Who is in a Surface, by name (null for someone not named yet), who made
 * it, and whether they only added it here (an artifact, bot or task made
 * elsewhere).
 */
data class SurfacePeople(val members: List<String?>, val creator: String?, val added: Boolean = false)

/** Desktop's `surfaceMembersText`: "Ann", "Ann and Bo", "Ann, Bo and 3 others", "Nobody has joined". */
@Composable
internal fun surfaceMembersText(members: List<String?>): String {
    val someone = stringResource(R.string.document_someone)
    val names = members.map { it ?: someone }
    return when (names.size) {
        0 -> stringResource(R.string.surface_members_none)
        1 -> names[0]
        2 -> stringResource(R.string.surface_members_two, names[0], names[1])
        else -> pluralStringResource(R.plurals.surface_members_more, names.size - 2, names[0], names[1], names.size - 2)
    }
}

@Composable
internal fun SurfaceLeaveMenu(
    name: String,
    onBack: () -> Unit,
    extraItems: @Composable ColumnScope.(close: () -> Unit) -> Unit = {},
    people: SurfacePeople? = null,
    leave: suspend () -> String?,
) {
    var expanded by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(false) }
    var refused by remember { mutableStateOf<String?>(null) }
    var leaving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val refusals = LocalResources.current
    Box {
        IconButton(onClick = { expanded = true }, enabled = !leaving, modifier = Modifier.size(48.dp).testTag("surface.more")) {
            Icon(Ionicon.EllipsisVertical, 24.dp, HappyTheme.colors.text, contentDescription = stringResource(R.string.conversation_composer_more))
        }
        HappyDropdownMenu(expanded, onDismissRequest = { expanded = false }) {
            if (people != null) {
                val credit = people.creator?.let { stringResource(if (people.added) R.string.surface_added_by else R.string.surface_created_by, it) }
                HappyMenuItem(
                    surfaceMembersText(people.members),
                    onClick = {},
                    modifier = Modifier.testTag("surface.people"),
                    supporting = credit,
                    enabled = false,
                )
            }
            extraItems { expanded = false }
            HappyMenuItem(stringResource(R.string.surface_leave), onClick = { expanded = false; confirming = true })
        }
    }
    if (confirming) HappyAlert(
        Alert(
            title = stringResource(R.string.surface_leave_title, name),
            message = stringResource(R.string.surface_leave_message),
            buttons = listOf(
                AlertButton(stringResource(R.string.common_cancel)),
                AlertButton(stringResource(R.string.surface_leave)) {
                    confirming = false
                    leaving = true
                    scope.launch {
                        try {
                            val reason = leave()
                            if (reason == null) onBack() else refused = refusals.refusalText(reason)
                        } finally { leaving = false }
                    }
                },
            ),
        ),
        onDismiss = { confirming = false },
    )
    refused?.let { reason ->
        HappyAlert(
            Alert(
                title = stringResource(R.string.surface_leave_failed, name),
                message = reason.ifEmpty { stringResource(R.string.surface_leave_no_answer) },
                buttons = listOf(AlertButton(stringResource(R.string.common_ok))),
            ),
            onDismiss = { refused = null },
        )
    }
}