package com.slopus.happy.ui.conversation

import android.text.format.DateFormat
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.foundation.verticalScroll
import com.slopus.happy.ui.components.PageProgressIndicator as CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.slopus.happy.R
import com.slopus.happy.agent.AgentFamily
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.artifacts.formatDuration
import com.slopus.happy.conversation.AgentChild
import com.slopus.happy.conversation.InlinePicture
import com.slopus.happy.conversation.KeptMedia
import com.slopus.happy.conversation.AgentDetail
import com.slopus.happy.conversation.ConversationViewing
import com.slopus.happy.conversation.ContextUsage
import com.slopus.happy.conversation.DetailFormat
import com.slopus.happy.conversation.MediaRef
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.Shared
import com.slopus.happy.conversation.SharedLink
import com.slopus.happy.conversation.SharedMedia
import com.slopus.happy.conversation.ViewerItem
import com.slopus.happy.model.settings.ModeOptions
import com.slopus.happy.text.pluralResource
import com.slopus.happy.ui.browser.LocalLinkOpener
import com.slopus.happy.ui.chat.rememberCopyText
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.components.RemoteImage
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.ShimmerSpec
import com.slopus.happy.ui.components.ShimmerText
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.components.avatar.PlaceholderAvatar
import com.slopus.happy.ui.components.barInsetTop
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.components.rememberThumbHash
import com.slopus.happy.ui.components.shimmer
import com.slopus.happy.ui.connection.AgentHomeSpec
import com.slopus.happy.ui.connection.ConversationMark
import com.slopus.happy.ui.connection.RowTile
import com.slopus.happy.ui.layout.ContentTokens
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Date

object AgentPageTags {
    const val SCREEN = "agentPage.screen"
    const val SCROLL = "agentPage.scroll"
    const val ERROR = "agentPage.error"
    const val MARK = "agentPage.mark"
    const val NAME = "agentPage.name"
    const val SUBTITLE = "agentPage.subtitle"
    /** Every section's heading: Family, Media, Links, Activity, Details. */
    const val HEADING = "agentPage.heading"
    const val FAMILY = "agentPage.family"
    const val FAMILY_ROW = "agentPage.family.row"
    const val TILES = "agentPage.tiles"
    const val TILE = "agentPage.tile"
    /** A value not known yet: a shimmering bar in its place. */
    const val PLACEHOLDER = "agentPage.placeholder"
    const val MEDIA = "agentPage.media"
    const val MEDIA_CELL = "agentPage.media.cell"
    const val MEDIA_MORE = "agentPage.media.more"
    const val LINKS = "agentPage.links"
    const val LINK = "agentPage.link"
    const val LINKS_MORE = "agentPage.links.more"
    const val RUNNING = "agentPage.running"
    const val COMPLETED = "agentPage.completed"
    const val COMPLETED_TOGGLE = "agentPage.completed.toggle"
    const val ACTIVITY_ROW = "agentPage.activity.row"
    /** The chat's controls under the tiles: its permission mode. */
    const val CONTROLS = "agentPage.controls"
    const val PERMISSION = "agentPage.controls.permission"
    const val DETAILS = "agentPage.details"
    const val DETAILS_ROW = "agentPage.details.row"
    const val CHANGES = "agentPage.details.changes"
    const val FILES = "agentPage.details.files"
}

/**
 * The agent page's measures, iOS's `SessionDetailLayout.Metrics` in dp
 * (HappyLayout/Agents/SessionDetailLayout.swift): the 88 mark 12 under the
 * list's top, the name 14 under it and the kind line 2 under that; then
 * 24 to the cards, which keep the content column's 16 inset (Settings' 16
 * side, iOS's too), are rounded 26 and sit 24 apart, each section's
 * heading (13/18, capitals) 16 in over its card with 8 under it.
 */
object AgentPageSpec {
    val top = 12.dp
    val mark = 88.dp
    /** iOS rounds a picture's or placeholder's corners at 0.22 of its side. */
    val markRadius = 19.dp
    val nameGap = 14.dp
    val subtitleGap = 2.dp
    val textSide = 24.dp
    val side = ContentTokens.inset
    val radius = 26.dp
    val cardGap = 24.dp
    val tilesTop = 24.dp
    val tileGap = 10.dp
    val tileHeight = 80.dp
    val tileRadius = 22.dp
    val tileInset = 16.dp
    val valueTop = 14.dp
    val headingInset = 16.dp
    val headingGap = 8.dp
    /** Telegram's shared media: three to a row, square, 2 apart. */
    const val MEDIA_COLUMNS = 3
    val mediaGap = 2.dp
    /** Four rows of media, five links; each "Show more" as many again (links twice as many). */
    const val MEDIA_PAGE = 12
    const val LINKS_PAGE = 5
    val playSize = 36.dp
    val fileGlyph = 30.dp
    /** A link, an agent or a terminal: what it is over a quieter line. */
    val activityRow = 62.dp
    /** A settings row: "Completed", "Show more", a detail. */
    val row = 52.dp
    val tile = 30.dp
    val tileCorner = 8.dp
    val glyph = 20.dp
    /** Where a row's text starts when it has a tile: the tile centred in the room before it. */
    val textX = 62.dp
    val plainTextX = 16.dp
    val trailing = 16.dp
    val bottom = 32.dp

    val name = happyTextStyle(fontSize = 28, lineHeight = 34, weight = FontWeight.Medium)
    val subtitle = happyTextStyle(fontSize = 17, lineHeight = 22)
    val heading = happyTextStyle(fontSize = 13, lineHeight = 18)
    val value = happyTextStyle(fontSize = 24, lineHeight = 30, weight = FontWeight.SemiBold)
    val label = happyTextStyle(fontSize = 13, lineHeight = 18)
    val title = happyTextStyle(fontSize = 17, lineHeight = 22)
    val meta = happyTextStyle(fontSize = 13, lineHeight = 18)
    val fileName = happyTextStyle(fontSize = 12, lineHeight = 15)
}

/** What the agent is, as its kind line says it. */
enum class AgentKind { Bot, Task, Subtask, Subagent, Conversation }

/** The agent that manages this one: opened from its row. */
@Immutable
data class AgentPageParent(val id: String, val title: String?)

/**
 * Everything the agent page shows, gathered by its entry from the chat
 * under it, home's tree, the bootstrap and history. Nothing here is a
 * guess: what isn't known yet is null and shows as a placeholder, or not
 * at all.
 */
@Immutable
data class AgentPageState(
    val agentId: String,
    /** Home's name for it, else the agent's title; null before either is read. */
    val name: String? = null,
    val kind: AgentKind? = null,
    val working: Boolean = false,
    val awaitingAnswer: Boolean = false,
    /** Home's row for it: its mark. */
    val row: AgentFeedRow.Conversation? = null,
    val family: List<AgentFamily.Member> = emptyList(),
    val mode: Mode? = null,
    /** The model's and provider's names from the computer's catalog, when it has been read. */
    val modelName: String? = null,
    val providerName: String? = null,
    val detail: AgentDetail? = null,
    /** The bootstrap hasn't answered yet. */
    val reading: Boolean = true,
    /** Why the agent couldn't be read; the page says it only while it knows nothing else. */
    val error: String? = null,
    val shared: Shared = Shared(),
    /** Older history is still unread and may share more. */
    val sharedMore: Boolean = false,
    /** History is being read with nothing shared in hand yet. */
    val sharedReading: Boolean = false,
    val project: String? = null,
    val workspace: String? = null,
    val parent: AgentPageParent? = null,
    /** The workspace it works in, whose Git changes it opens; null where it has none known. */
    val workspaceId: String? = null,
    /** That workspace's changed lines, as home's row counts them. */
    val lineChanges: com.slopus.happy.agent.WorkspaceLineChanges? = null,
    /** The mode of the chat this page was opened over, whose permission mode it shows and picks; null opened from anywhere else. */
    val chatMode: Mode? = null,
)

class AgentPageActions(
    val onBack: () -> Unit = {},
    /** Another conversation of the family or the activity, over this page. */
    val onOpenConversation: (String) -> Unit = {},
    /** History far enough back for [media] media and [links] links, so each section knows whether there is more. */
    val onWant: (media: Int, links: Int) -> Unit = { _, _ -> },
    val loadMedia: suspend (MediaRef) -> ByteArray = { throw IllegalStateException() },
    /** One byte range of a presented recording, so it streams; null where ranges can't be asked for. */
    val loadMediaRange: (suspend (MediaRef, LongRange) -> TransportResponse)? = null,
    /** The connection's media kept on this phone, which the grid reads through and rings over, as the chat does. */
    val kept: KeptMedia? = null,
    /** The workspace's changes against its base ([WorkspaceChangesRoute]). */
    val onOpenChanges: (String) -> Unit = {},
    /** The workspace's folder ([com.slopus.happy.ui.files.WorkspaceFilesRoute]). */
    val onOpenFiles: (String) -> Unit = {},
    /** A permission mode picked here, sent through the chat beneath as its header's menu sends it. */
    val onModeChange: (Mode) -> Unit = {},
)

/**
 * An agent's page, opened from its chat's title or menu: iOS's
 * conversation detail (`SessionDetailViewController`, laid out by
 * `SessionDetailLayout`) in this app's glass and cards. Under the standard
 * glass bar, whose title fades in as the large name scrolls under it, the
 * list scrolls on: the agent's mark (its picture, Happy's, or the
 * placeholder its ID picks, moving with Animated Avatars), its name, and
 * its kind with what it is doing ("Task · Working"); where it sits in
 * home's tree ([AgentFamily]); model, effort, when it started and its
 * subtree's tokens as tiles, two to a row and an odd last one the row's
 * width; what it shared, Telegram's shared media in our cards (pictures,
 * recordings and files three to a row, square, 2 apart, opening the
 * viewer or the phone's app; then the links written in it), each "Show
 * more" reading further back; desktop's Activity (children at work and
 * terminals running, then the settled children under a fold); opened
 * over its chat, that chat's permission mode under the tiles (iOS
 * da5fda505); and its details (provider, permission mode, context, project, workspace, the
 * agent that started it, its ID). A section with nothing in it isn't drawn.
 * While a value is read it shimmers in its place. Every row of a family or
 * activity opens its conversation.
 */
@Composable
fun AgentPageScreen(state: AgentPageState, actions: AgentPageActions, now: Long = System.currentTimeMillis()) {
    val scroll = rememberScrollState()
    val density = LocalDensity.current
    val untitled = stringResource(R.string.conversation_untitled)
    val name = state.name ?: untitled.takeIf { !state.reading || state.error != null }
    // The bar's title comes in as the large name goes under it.
    val nameTop = with(density) { (AgentPageSpec.top + AgentPageSpec.mark + AgentPageSpec.nameGap).toPx() }
    val nameHeight = with(density) { AgentPageSpec.name.lineHeight.toPx() }
    Screen(
        header = {
            StackHeader(
                title = name.orEmpty(),
                onBack = actions.onBack,
                titleAlpha = { ((scroll.value - nameTop) / nameHeight).coerceIn(0f, 1f) },
            )
        },
        modifier = Modifier.testTag(AgentPageTags.SCREEN),
    ) {
        if (state.error != null && state.name == null && state.detail == null) {
            Text(
                state.error,
                style = MaterialTheme.typography.bodyLarge,
                color = HappyTheme.colors.textSecondary,
                textAlign = TextAlign.Center,
                modifier = Modifier.align(Alignment.Center).padding(32.dp).testTag(AgentPageTags.ERROR),
            )
        } else {
            Column(Modifier.fillMaxSize().verticalScroll(scroll).testTag(AgentPageTags.SCROLL)) {
                Spacer(Modifier.height(barInsetTop()))
                Column(Modifier.contentMaxWidth(LocalWindowLayout.current)) {
                    Page(state, name, actions, now)
                }
            }
        }
    }
}

@Composable
private fun Page(state: AgentPageState, name: String?, actions: AgentPageActions, now: Long) {
    Hero(state, name)
    Spacer(Modifier.height(AgentPageSpec.tilesTop))
    if (state.family.isNotEmpty()) {
        Section(stringResource(R.string.agent_page_family)) {
            Card(AgentPageTags.FAMILY) { state.family.forEachIndexed { index, member -> FamilyRow(member, index == state.family.lastIndex, actions) } }
        }
    }
    Tiles(state, now)
    Spacer(Modifier.height(AgentPageSpec.cardGap))
    state.chatMode?.let {
        Controls(it, actions)
        Spacer(Modifier.height(AgentPageSpec.cardGap))
    }
    SharedSections(state, actions)
    state.detail?.let { Activity(it, now, actions) }
    Details(state, actions)
    Spacer(Modifier.height(AgentPageSpec.bottom - AgentPageSpec.cardGap))
}

/** The mark, the name and the kind line, centred. */
@Composable
private fun Hero(state: AgentPageState, name: String?) {
    val colors = HappyTheme.colors
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        Spacer(Modifier.height(AgentPageSpec.top))
        Box(Modifier.size(AgentPageSpec.mark).testTag(AgentPageTags.MARK)) {
            val row = state.row
            if (row != null) ConversationMark(row, AgentPageSpec.mark, AgentPageSpec.markRadius)
            else PlaceholderAvatar(state.agentId, AgentPageSpec.mark, shape = RoundedCornerShape(AgentPageSpec.markRadius))
        }
        Spacer(Modifier.height(AgentPageSpec.nameGap))
        val nameLine = with(LocalDensity.current) { AgentPageSpec.name.lineHeight.toDp() }
        Box(
            Modifier
                .padding(horizontal = AgentPageSpec.textSide)
                .heightIn(min = nameLine)
                .testTag(AgentPageTags.NAME),
            contentAlignment = Alignment.Center,
        ) {
            if (name != null) {
                Text(
                    name,
                    style = AgentPageSpec.name,
                    color = colors.text,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.semantics { heading() },
                )
            } else {
                Placeholder(Modifier.width(180.dp).height(26.dp))
            }
        }
        Spacer(Modifier.height(AgentPageSpec.subtitleGap))
        val kind = state.kind?.let { kindName(it) }
        val doing = when {
            state.awaitingAnswer -> stringResource(R.string.agent_page_awaiting_answer)
            state.working -> stringResource(R.string.conversation_status_working)
            else -> null
        }
        Text(
            listOfNotNull(kind, doing).joinToString(" · "),
            style = AgentPageSpec.subtitle,
            color = colors.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = AgentPageSpec.textSide).fillMaxWidth().testTag(AgentPageTags.SUBTITLE),
        )
    }
}

@Composable
private fun kindName(kind: AgentKind): String = stringResource(
    when (kind) {
        AgentKind.Bot -> R.string.new_work_bot
        AgentKind.Task -> R.string.new_work_task
        AgentKind.Subtask -> R.string.agent_page_subtask
        AgentKind.Subagent -> R.string.agent_page_subagent
        AgentKind.Conversation -> R.string.conversation_details_conversation
    },
)

/** A section's heading (13/18 capitals, 16 in) over its [content] card, 24 before the next. */
@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Text(
        title.uppercase(),
        style = AgentPageSpec.heading,
        color = HappyTheme.colors.textSecondary,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .padding(horizontal = AgentPageSpec.side + AgentPageSpec.headingInset)
            .testTag(AgentPageTags.HEADING)
            .semantics { heading() },
    )
    Spacer(Modifier.height(AgentPageSpec.headingGap))
    content()
    Spacer(Modifier.height(AgentPageSpec.cardGap))
}

/** One card: the page's surface, rounded 26, on the content column's 16 inset. */
@Composable
private fun Card(tag: String, content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier
            .padding(horizontal = AgentPageSpec.side)
            .fillMaxWidth()
            .testTag(tag)
            .clip(RoundedCornerShape(AgentPageSpec.radius))
            .background(HappyTheme.colors.surface),
        content = content,
    )
}

/** A value being read: a quiet bar with desktop's sheen through it (still with animations off). */
@Composable
private fun Placeholder(modifier: Modifier) {
    val colors = HappyTheme.colors
    val ground = colors.surfaceHighest
    val still = rememberReduceMotion()
    Box(
        modifier
            .testTag(AgentPageTags.PLACEHOLDER)
            .clip(RoundedCornerShape(6.dp))
            .background(ground)
            .then(if (still) Modifier else Modifier.shimmer(lerp(ground, if (colors.dark) Color.White else Color.Black, 0.06f))),
    )
}

/** One row of the family: home's row, its own highlighted; a tap opens that conversation. */
@Composable
private fun FamilyRow(member: AgentFamily.Member, last: Boolean, actions: AgentPageActions) {
    val colors = HappyTheme.colors
    val row = member.row
    val marked = AgentHomeSpec.hasMark(row.kind)
    val start = AgentHomeSpec.markInset + AgentHomeSpec.indent * member.depth
    val ground = if (member.self) colors.surfaceSelected else colors.surface
    Box(
        Modifier
            .fillMaxWidth()
            .height(AgentHomeSpec.rowHeight())
            .testTag(AgentPageTags.FAMILY_ROW)
            .background(ground)
            .clickable(role = Role.Button) { if (member.self) actions.onBack() else actions.onOpenConversation(row.agentId) },
    ) {
        Row(
            Modifier.fillMaxSize().padding(start = start, end = AgentHomeSpec.paddingEnd),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (marked) Box(Modifier.size(AgentHomeSpec.mark)) { ConversationMark(row, AgentHomeSpec.mark) }
            ShimmerText(
                text = row.title ?: stringResource(R.string.session_new_chat),
                style = AgentHomeSpec.title,
                baseColor = colors.text,
                highlightColor = ShimmerSpec.sheen(colors.text, ground),
                shimmering = row.running,
                modifier = Modifier
                    .padding(start = if (marked) AgentHomeSpec.markGap else 0.dp)
                    .weight(1f)
                    .wrapContentHeight(unbounded = true),
            )
        }
        if (!last) Divider(start + if (marked) AgentHomeSpec.mark + AgentHomeSpec.markGap else 0.dp)
    }
}

@Composable
private fun BoxScope.Divider(start: Dp) {
    Box(
        Modifier
            .align(Alignment.BottomStart)
            .padding(start = start)
            .fillMaxWidth()
            .height(hairline())
            .background(HappyTheme.colors.divider),
    )
}

/**
 * Model, effort, when it started and its subtree's tokens: the model's
 * name as the catalog has it (else its ID), the effort's, the start as a
 * person says it, tokens as 1.2K. Read but never recorded, a value is
 * "—"; not read yet, it shimmers.
 */
@Composable
private fun Tiles(state: AgentPageState, now: Long) {
    val none = stringResource(R.string.agent_page_none)
    val mode = state.detail?.mode ?: state.mode
    val reading = state.reading && state.detail == null
    val created = state.detail?.agent?.createdAt
    val tokens = state.detail?.tokens
    val tiles = buildList {
        add((state.modelName ?: mode?.modelId ?: none.takeUnless { reading }) to stringResource(R.string.conversation_details_model))
        add((mode?.effort?.let(ModeOptions::effortDisplayName) ?: none.takeUnless { reading }) to stringResource(R.string.conversation_details_effort))
        add((created?.let { startedText(it, now) } ?: none.takeUnless { reading }) to stringResource(R.string.agent_page_started))
        if (tokens != null) add(DetailFormat.tokens(tokens) to stringResource(R.string.usage_tokens))
    }
    Column(
        Modifier.padding(horizontal = AgentPageSpec.side).fillMaxWidth().testTag(AgentPageTags.TILES),
        verticalArrangement = Arrangement.spacedBy(AgentPageSpec.tileGap),
    ) {
        tiles.chunked(2).forEach { pair ->
            Row(horizontalArrangement = Arrangement.spacedBy(AgentPageSpec.tileGap)) {
                pair.forEach { (value, label) -> Tile(value, label, Modifier.weight(1f)) }
            }
        }
    }
}

/** One number: large (24/30 semibold, shrinking to fit), over what it counts (13/18). */
@Composable
private fun Tile(value: String?, label: String, modifier: Modifier) {
    val colors = HappyTheme.colors
    Column(
        modifier
            .testTag(AgentPageTags.TILE)
            .heightIn(min = AgentPageSpec.tileHeight)
            .clip(RoundedCornerShape(AgentPageSpec.tileRadius))
            .background(colors.surface)
            .semantics(mergeDescendants = true) {}
            .padding(start = AgentPageSpec.tileInset, end = AgentPageSpec.tileInset, top = AgentPageSpec.valueTop, bottom = 4.dp),
    ) {
        val line = with(LocalDensity.current) { AgentPageSpec.value.lineHeight.toDp() }
        Box(Modifier.fillMaxWidth().heightIn(min = line), contentAlignment = Alignment.CenterStart) {
            if (value != null) {
                BasicText(
                    value,
                    style = AgentPageSpec.value.copy(color = colors.text),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    autoSize = TextAutoSize.StepBased(minFontSize = 14.sp, maxFontSize = AgentPageSpec.value.fontSize),
                )
            } else {
                Placeholder(Modifier.width(72.dp).height(20.dp))
            }
        }
        Text(label, style = AgentPageSpec.label, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun startedText(since: Long, now: Long): String {
    val context = LocalContext.current
    val locale = LocalConfiguration.current.locales[0]
    val zone = ZoneId.systemDefault()
    val date = Instant.ofEpochMilli(since).atZone(zone)
    fun pattern(skeleton: String) = DateTimeFormatter.ofPattern(DateFormat.getBestDateTimePattern(locale, skeleton), locale)
    val time = DateFormat.getTimeFormat(context).format(Date(since))
    return when (DetailFormat.started(since, now, zone)) {
        DetailFormat.Started.Today -> stringResource(R.string.agent_page_started_today, time)
        DetailFormat.Started.Yesterday -> stringResource(R.string.agent_page_started_yesterday, time)
        DetailFormat.Started.Weekday -> date.format(pattern("EEEjmm"))
        DetailFormat.Started.ThisYear -> date.format(pattern("MMMd"))
        DetailFormat.Started.Date -> date.format(pattern("yMMMd"))
    }
}

@Composable
private fun ageText(age: DetailFormat.Age): String = when (age) {
    DetailFormat.Age.JustNow -> stringResource(R.string.agent_page_age_just_now)
    is DetailFormat.Age.Minutes -> pluralResource(R.plurals.agent_page_age_minutes, age.count, age.count)
    is DetailFormat.Age.Hours -> pluralResource(R.plurals.agent_page_age_hours, age.count, age.count)
    is DetailFormat.Age.Days -> pluralResource(R.plurals.agent_page_age_days, age.count, age.count)
    is DetailFormat.Age.Months -> pluralResource(R.plurals.agent_page_age_months, age.count, age.count)
    is DetailFormat.Age.Years -> pluralResource(R.plurals.agent_page_age_years, age.count, age.count)
}

/**
 * Media, then Links: what the chat in hand shows, then what history adds
 * behind it. Four rows of media and five links to start; "Show more" adds
 * as many again (twice as many links) and reads history back far enough
 * to know whether there is more still. While the first page is read with
 * nothing shared in hand, a row of shimmering squares holds Media's place.
 */
@Composable
private fun SharedSections(state: AgentPageState, actions: AgentPageActions) {
    var mediaLimit by rememberSaveable { mutableIntStateOf(AgentPageSpec.MEDIA_PAGE) }
    var linksLimit by rememberSaveable { mutableIntStateOf(AgentPageSpec.LINKS_PAGE) }
    LaunchedEffect(mediaLimit, linksLimit) { actions.onWant(mediaLimit + 1, linksLimit + 1) }
    val shared = state.shared
    val store = rememberConversationMediaStore(actions.loadMedia, actions.loadMediaRange, actions.kept)
    val opener = rememberMediaOpener()
    // A recording plays once its first range is here, its tile spinning till then.
    val videos = rememberVideoOpening(store::video)
    var viewing by remember { mutableStateOf<Int?>(null) }
    val media = shared.media.take(mediaLimit)
    if (media.isNotEmpty() || (state.sharedReading && shared.isEmpty)) {
        Section(stringResource(R.string.agent_page_media)) {
            Card(AgentPageTags.MEDIA) {
                if (media.isEmpty()) {
                    MediaGrid(AgentPageSpec.MEDIA_COLUMNS) { Placeholder(Modifier.fillMaxSize()) }
                } else {
                    val visual = remember(shared.media) { shared.media.filter { it.isVisual } }
                    MediaGrid(media.size) { index ->
                        val one = media[index]
                        MediaCell(one, store, opener, starting = videos.isStarting(one.key)) {
                            when (one) {
                                is SharedMedia.Presented -> {
                                    if (!one.ref.item.isVisual) {
                                        opener.open(one.ref.key, one.ref.item, inApp = true) { store.file(one.ref) }
                                        return@MediaCell
                                    }
                                    // A picture not here yet is read first, as a tap on its ring does.
                                    val kept = store.kept
                                    if (kept != null && !one.isVideo && kept.phase(one.ref)?.isComplete != true) {
                                        kept.toggle(one.ref)
                                        return@MediaCell
                                    }
                                }
                                is SharedMedia.Picture -> Unit
                            }
                            val at = visual.indexOfFirst { it.key == one.key }.takeIf { it >= 0 }
                            if (one is SharedMedia.Presented && one.isVideo) videos.open(one.key, one.ref) { viewing = at } else viewing = at
                        }
                    }
                    if (shared.media.size > mediaLimit || state.sharedMore) {
                        MoreRow(AgentPageTags.MEDIA_MORE) { mediaLimit += AgentPageSpec.MEDIA_PAGE }
                    }
                }
            }
        }
    }
    val links = shared.links.take(linksLimit)
    if (links.isNotEmpty()) {
        Section(stringResource(R.string.agent_page_links)) {
            Card(AgentPageTags.LINKS) {
                val more = shared.links.size > linksLimit || state.sharedMore
                links.forEachIndexed { index, link -> LinkRow(link, last = index == links.lastIndex && !more) }
                if (more) MoreRow(AgentPageTags.LINKS_MORE) { linksLimit += 2 * AgentPageSpec.LINKS_PAGE }
            }
        }
    }
    viewing?.let { index -> SharedViewer(shared.media.filter { it.isVisual }, index, store) { viewing = null } }
    MediaPreview(opener)
}

/** [count] squares, three to a row and 2 apart, the last column ending on the card's edge. */
@Composable
private fun MediaGrid(count: Int, cell: @Composable (Int) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(AgentPageSpec.mediaGap)) {
        (0 until count).chunked(AgentPageSpec.MEDIA_COLUMNS).forEach { line ->
            Row(horizontalArrangement = Arrangement.spacedBy(AgentPageSpec.mediaGap)) {
                for (column in 0 until AgentPageSpec.MEDIA_COLUMNS) {
                    Box(Modifier.weight(1f).aspectRatio(1f)) { line.getOrNull(column)?.let { cell(it) } }
                }
            }
        }
    }
}

/**
 * One square of the grid (iOS's `SharedMediaCell`): a picture filling it
 * over its ThumbHash, a recording's first frame under a 36 play button, or
 * a file's glyph over its name (12/15, two lines); on surfacePressed until
 * it lands. A file being opened shows a spinner, and why it couldn't open.
 */
@Composable
private fun MediaCell(media: SharedMedia, store: ConversationMediaStore, opener: MediaOpener, starting: Boolean = false, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    val pictureLabel = stringResource(R.string.conversation_picture)
    val videoLabel = stringResource(R.string.artifact_video)
    val label = when (media) {
        is SharedMedia.Picture -> pictureLabel
        is SharedMedia.Presented -> if (media.isVideo) videoLabel else media.ref.item.name.ifEmpty { pictureLabel }
    }
    Box(
        Modifier
            .fillMaxSize()
            .then(if (media.isVisual) Modifier.viewerOrigin(media.key) else Modifier)
            .testTag(AgentPageTags.MEDIA_CELL)
            .background(colors.surfacePressed)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics(mergeDescendants = true) { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        when (media) {
            is SharedMedia.Picture -> {
                val bytes = remember(media.key) { InlinePicture.of(media.image).bytes }
                RemoteImage(model = bytes, contentDescription = null, cacheKey = media.key, modifier = Modifier.fillMaxSize())
            }
            is SharedMedia.Presented -> PresentedCell(media.ref, media.key, store, opener, starting, onClick)
        }
    }
}

/** A presented item's square; kept, it reads, rings and plays as the chat's tile does (iOS `SharedMediaCell`). */
@Composable
private fun BoxScope.PresentedCell(ref: MediaRef, key: String, store: ConversationMediaStore, opener: MediaOpener, starting: Boolean, onPlay: () -> Unit) {
    val colors = HappyTheme.colors
    val item = ref.item
    when {
        item.kind == "video" -> {
            val poster by produceState<VideoPoster?>(null, ref.key) {
                value = runCatching { store.poster(ref) }.getOrNull()
            }
            val still = remember(poster) { poster?.frame?.asImageBitmap() }
            val placeholder = rememberThumbHash(item.thumbhash)
            (still ?: placeholder)?.let { Image(it, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
            val kept = store.kept
            if (kept != null) {
                DownloadStatus(ref, kept, video = true, duration = poster?.seconds?.let(::formatDuration), starting = starting, onPlay = onPlay)
            } else {
                Box(Modifier.size(AgentPageSpec.playSize).clip(CircleShape).background(PlayFill), contentAlignment = Alignment.Center) {
                    androidx.compose.material3.Icon(MaterialSymbols.PlayArrow, null, tint = PlayGlyph, modifier = Modifier.size(18.dp))
                }
            }
        }
        item.isVisual -> {
            // Read again once it is here, where it waited for a tap.
            val kept = store.kept
            val here = kept?.phase(ref)?.isComplete == true
            val bytes by produceState<ByteArray?>(null, ref.key, here) {
                if (value != null) return@produceState
                value = try {
                    store.bytes(ref)
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (_: Exception) {
                    null
                }
            }
            RemoteImage(
                model = bytes,
                contentDescription = null,
                cacheKey = key,
                placeholder = rememberThumbHash(item.thumbhash),
                modifier = Modifier.fillMaxSize(),
            )
            if (kept != null) DownloadStatus(ref, kept, video = false)
        }
        else -> {
            val opening = opener.state(ref.key)
            Column(Modifier.padding(horizontal = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                if (opening is MediaOpening.Reading) {
                    CircularProgressIndicator(color = colors.textSecondary, strokeWidth = 2.dp, modifier = Modifier.size(AgentPageSpec.fileGlyph))
                } else {
                    Icon(Ionicon.DocumentTextOutline, AgentPageSpec.fileGlyph, colors.textSecondary)
                }
                Spacer(Modifier.height(6.dp))
                Text(
                    (opening as? MediaOpening.Failed)?.reason ?: item.name,
                    style = AgentPageSpec.fileName,
                    color = colors.textSecondary,
                    textAlign = TextAlign.Center,
                    maxLines = 2,
                    overflow = TextOverflow.MiddleEllipsis,
                )
            }
        }
    }
}

/** The viewer over every picture and recording shared, newest first, opened at [index]. */
@Composable
private fun SharedViewer(visual: List<SharedMedia>, index: Int, store: ConversationMediaStore, onClose: () -> Unit) {
    val pictureLabel = stringResource(R.string.conversation_picture)
    val videoLabel = stringResource(R.string.artifact_video)
    val entries = remember(visual) {
        visual.map { one ->
            when (one) {
                is SharedMedia.Picture -> ConversationViewing.Entry(ViewerItem(one.key, pictureLabel), inline = one.image)
                is SharedMedia.Presented -> ConversationViewing.Entry(
                    ViewerItem(
                        key = one.key,
                        label = one.ref.item.name.ifEmpty { if (one.isVideo) videoLabel else pictureLabel },
                        isVideo = one.isVideo,
                        width = one.ref.item.width?.toFloat(),
                        height = one.ref.item.height?.toFloat(),
                        thumbhash = one.ref.item.thumbhash,
                    ),
                    presented = one.ref,
                )
            }
        }
    }
    val source = remember(entries, store) { ConversationViewerSource(entries, store) }
    PictureViewer(remember(entries) { entries.map { it.item } }, index, source, onClose)
}

/** "Show more", a settings row in the link colour. */
@Composable
private fun MoreRow(tag: String, onClick: () -> Unit) {
    Box(
        Modifier
            .fillMaxWidth()
            .heightIn(min = AgentPageSpec.row)
            .testTag(tag)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = AgentPageSpec.plainTextX),
        contentAlignment = Alignment.CenterStart,
    ) {
        Text(stringResource(R.string.agent_page_show_more), style = AgentPageSpec.title, color = HappyTheme.colors.textLink)
    }
}

/** A link: its text or host over its address; a tap opens it as a link in the chat does, a hold offers the link menu. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun LinkRow(link: SharedLink, last: Boolean) {
    val opener = LocalLinkOpener.current
    val uri = LocalUriHandler.current
    ListRow(
        glyph = Ionicon.LinkOutline,
        tile = RowTile.Blue,
        title = link.title ?: link.host,
        meta = Shared.address(link.url),
        last = last,
        tag = AgentPageTags.LINK,
        onClick = { opener?.open(link.url) ?: uri.openUri(link.url) },
        onLongClick = opener?.let { { it.showMenu(link.url) } },
    )
}

/**
 * One row of a list card (iOS's `DetailActivityCardView.RowView`): a 30
 * glyph tile centred in the 62 before the text, the title (17/22) over a
 * quieter line (13/18), 62 high, a hairline from the text under every row
 * but the card's last.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ListRow(
    glyph: Ionicon,
    tile: RowTile?,
    title: String,
    meta: String,
    last: Boolean,
    tag: String,
    onClick: (() -> Unit)?,
    onLongClick: (() -> Unit)? = null,
    shimmering: Boolean = false,
) {
    val colors = HappyTheme.colors
    Box(
        Modifier
            .fillMaxWidth()
            .heightIn(min = AgentPageSpec.activityRow)
            .testTag(tag)
            .then(
                if (onClick != null) Modifier.combinedClickable(role = Role.Button, onClick = onClick, onLongClick = onLongClick)
                else Modifier.semantics(mergeDescendants = true) {},
            ),
    ) {
        Row(Modifier.fillMaxWidth().heightIn(min = AgentPageSpec.activityRow), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.width(AgentPageSpec.textX), contentAlignment = Alignment.Center) { GlyphTile(glyph, tile) }
            Column(Modifier.weight(1f).padding(end = AgentPageSpec.trailing, top = 10.dp, bottom = 10.dp)) {
                ShimmerText(
                    title,
                    style = AgentPageSpec.title,
                    baseColor = colors.text,
                    highlightColor = ShimmerSpec.sheen(colors.text, colors.surface),
                    shimmering = shimmering,
                )
                Text(meta, style = AgentPageSpec.meta, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (!last) Divider(AgentPageSpec.textX)
    }
}

/** A glyph on its tinted tile, 30 square rounded 8; [tile] null is the quiet grey of a terminal or a settled agent. */
@Composable
private fun GlyphTile(glyph: Ionicon, tile: RowTile?) {
    val colors = HappyTheme.colors
    val fill = tile?.fill(colors.dark) ?: colors.surfaceHighest
    val ink = tile?.ink(colors.dark) ?: colors.textSecondary
    Box(Modifier.size(AgentPageSpec.tile).clip(RoundedCornerShape(AgentPageSpec.tileCorner)).background(fill), contentAlignment = Alignment.Center) {
        Icon(glyph, AgentPageSpec.glyph, ink)
    }
}

/**
 * Desktop's Activity: the children at work and the terminals running in
 * one card, then the settled children folded under "Completed" and their
 * count, which opens and closes them (its chevron turning).
 */
@Composable
private fun Activity(detail: AgentDetail, now: Long, actions: AgentPageActions) {
    if (detail.isQuiet) return
    Section(stringResource(R.string.session_info_activity)) {
        val working = detail.running.size + detail.terminals.size
        if (working > 0) {
            Card(AgentPageTags.RUNNING) {
                detail.running.forEachIndexed { index, child ->
                    ChildRow(child, last = index == working - 1, tile = RowTile.Purple, actions = actions)
                }
                detail.terminals.forEachIndexed { index, terminal ->
                    val age = terminal.startedAt?.let { ageText(DetailFormat.age(it, now)) }
                    ListRow(
                        glyph = Ionicon.TerminalOutline,
                        tile = null,
                        title = terminal.command,
                        meta = listOfNotNull(stringResource(R.string.agent_page_terminal_running), age).joinToString(" · "),
                        last = detail.running.size + index == working - 1,
                        tag = AgentPageTags.ACTIVITY_ROW,
                        onClick = null,
                    )
                }
            }
            if (detail.completed.isNotEmpty()) Spacer(Modifier.height(AgentPageSpec.cardGap))
        }
        if (detail.completed.isNotEmpty()) Completed(detail.completed, actions)
    }
}

@Composable
private fun Completed(children: List<AgentChild>, actions: AgentPageActions) {
    val colors = HappyTheme.colors
    var open by rememberSaveable { mutableStateOf(false) }
    val reduceMotion = rememberReduceMotion()
    val turn by animateFloatAsState(if (open) 90f else 0f, if (reduceMotion) snap() else tween(250), label = "chevron")
    val state = stringResource(if (open) R.string.agent_page_expanded else R.string.agent_page_collapsed)
    Card(AgentPageTags.COMPLETED) {
        Box(
            Modifier
                .fillMaxWidth()
                .heightIn(min = AgentPageSpec.row)
                .testTag(AgentPageTags.COMPLETED_TOGGLE)
                .clickable(role = Role.Button) { open = !open }
                .semantics { stateDescription = state },
        ) {
            Row(Modifier.fillMaxWidth().heightIn(min = AgentPageSpec.row), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.width(AgentPageSpec.textX), contentAlignment = Alignment.Center) { GlyphTile(Ionicon.CheckboxOutline, RowTile.Green) }
                Text(stringResource(R.string.agent_page_completed), style = AgentPageSpec.title, color = colors.text, modifier = Modifier.weight(1f))
                Text("${children.size}", style = AgentPageSpec.title, color = colors.textSecondary)
                Icon(
                    Ionicon.ChevronForward,
                    18.dp,
                    colors.textSecondary,
                    Modifier.padding(start = 8.dp, end = AgentPageSpec.trailing).graphicsLayer { rotationZ = turn },
                )
            }
            if (open) Divider(AgentPageSpec.textX)
        }
        AnimatedVisibility(
            open,
            enter = if (reduceMotion) androidx.compose.animation.EnterTransition.None else expandVertically(tween(250)),
            exit = if (reduceMotion) androidx.compose.animation.ExitTransition.None else shrinkVertically(tween(250)),
        ) {
            Column {
                children.forEachIndexed { index, child -> ChildRow(child, last = index == children.lastIndex, tile = null, actions = actions) }
            }
        }
    }
}

/** A child agent: its title (else "Subagent") over what it is doing and its tokens; a tap opens its conversation. */
@Composable
private fun ChildRow(child: AgentChild, last: Boolean, tile: RowTile?, actions: AgentPageActions) {
    val status = stringResource(
        when {
            child.archived -> R.string.agent_page_status_closed
            child.status == "idle" -> R.string.agent_page_status_done
            child.status == "thinking" -> R.string.agent_page_status_thinking
            child.status == "generating_tools" || child.status == "running_tools" -> R.string.agent_page_status_running_tools
            else -> R.string.agent_page_status_working
        },
    )
    val tokens = child.tokens?.let { stringResource(R.string.agent_page_tokens, DetailFormat.tokens(it)) }
    ListRow(
        glyph = Ionicon.PeopleOutline,
        tile = tile,
        title = child.title ?: stringResource(if (child.subtask) R.string.agent_page_subtask else R.string.agent_page_subagent),
        meta = listOfNotNull(status, tokens).joinToString(" · "),
        last = last,
        tag = AgentPageTags.ACTIVITY_ROW,
        onClick = { actions.onOpenConversation(child.id) },
        shimmering = child.running,
    )
}

/**
 * What else is known of it, as Settings' rows: its provider, permission
 * mode and context, the project and workspace it runs in, the agent that
 * started it (opening its chat), and its ID (copied on tap).
 */
@Composable
private fun Details(state: AgentPageState, actions: AgentPageActions) {
    val copy = rememberCopyText()
    val mode = state.detail?.mode ?: state.mode
    val rows = buildList<@Composable (Boolean) -> Unit> {
        (state.providerName ?: mode?.providerId)?.let { add { last -> DetailRow(stringResource(R.string.agent_page_provider), it, last) } }
        // Over its chat the controls card shows it, and picks it.
        mode?.takeIf { state.chatMode == null }?.let { add { last -> DetailRow(stringResource(R.string.conversation_details_permission_mode), permissionName(it.permissionMode), last) } }
        state.detail?.context?.let { add { last -> DetailRow(stringResource(R.string.agent_page_context), contextText(it), last) } }
        state.project?.let { add { last -> DetailRow(stringResource(R.string.home_dock_picker_project), it, last) } }
        state.workspace?.let { add { last -> DetailRow(stringResource(R.string.home_dock_picker_workspace), it, last) } }
        state.workspaceId?.let { id ->
            add { last ->
                DetailRow(
                    stringResource(R.string.files_changes),
                    changesText(state.lineChanges),
                    last,
                    chevron = true,
                    onClick = { actions.onOpenChanges(id) },
                    tag = AgentPageTags.CHANGES,
                )
            }
            add { last ->
                DetailRow(stringResource(R.string.common_files), "", last, chevron = true, onClick = { actions.onOpenFiles(id) }, tag = AgentPageTags.FILES)
            }
        }
        state.parent?.let { parent ->
            add { last ->
                DetailRow(
                    stringResource(R.string.agent_page_parent),
                    parent.title ?: stringResource(R.string.conversation_untitled),
                    last,
                    chevron = true,
                    onClick = { actions.onOpenConversation(parent.id) },
                )
            }
        }
        add { last -> DetailRow(stringResource(R.string.conversation_details_agent_id), state.agentId, last, onClick = { copy(state.agentId) }) }
    }
    Section(stringResource(R.string.agent_page_details)) {
        Card(AgentPageTags.DETAILS) { rows.forEachIndexed { index, row -> row(index == rows.lastIndex) } }
    }
}

/**
 * The chat's controls as Settings' rows (iOS's `SessionDetailLayout`
 * controls card): its permission mode, the current one as the value. A tap
 * opens the modes from the row, the current one ticked, as the chat's
 * header menu lists them; a pick goes through the chat.
 */
@Composable
private fun Controls(mode: Mode, actions: AgentPageActions) {
    val colors = HappyTheme.colors
    var open by rememberSaveable { mutableStateOf(false) }
    val title = stringResource(R.string.conversation_details_permission_mode)
    Card(AgentPageTags.CONTROLS) {
        Box {
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = AgentPageSpec.row)
                    .clickable(role = Role.Button) { open = true }
                    .testTag(AgentPageTags.PERMISSION)
                    .padding(end = AgentPageSpec.trailing),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.width(AgentPageSpec.textX), contentAlignment = Alignment.Center) { GlyphTile(Ionicon.ShieldCheckmarkOutline, RowTile.Blue) }
                Text(title, style = AgentPageSpec.title, color = colors.text, maxLines = 1, modifier = Modifier.padding(end = 12.dp))
                Text(
                    permissionName(mode.permissionMode),
                    style = AgentPageSpec.title,
                    color = colors.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.End,
                    modifier = Modifier.weight(1f),
                )
            }
            ConversationModePicker(
                open = if (open) ModePicker.Permission else null,
                onClose = { open = false },
                catalog = null,
                mode = mode,
                onModeChange = actions.onModeChange,
                anchorCenterY = 0,
                belowAnchor = true,
            )
        }
    }
}

@Composable
private fun contextText(context: ContextUsage): String {
    val used = DetailFormat.tokens(context.tokens)
    return context.window?.let { stringResource(R.string.agent_page_context_value, used, DetailFormat.tokens(it)) } ?: used
}

/** A workspace's changed lines as home's row counts them ("+12 −3"); nothing when it has none to show. */
internal fun changesText(changes: com.slopus.happy.agent.WorkspaceLineChanges?): String {
    if (changes == null || !changes.visible) return ""
    return listOfNotNull(
        if (!changes.countsExact) "≈" else null,
        if (changes.insertions > 0) "+${com.slopus.happy.model.compactCount(changes.insertions)}" else null,
        if (changes.deletions > 0) "\u2212${com.slopus.happy.model.compactCount(changes.deletions)}" else null,
    ).joinToString(" ")
}

/** A detail: its name, then its value at the end (secondary, one line), 52 high. */
@Composable
private fun DetailRow(title: String, value: String, last: Boolean, chevron: Boolean = false, onClick: (() -> Unit)? = null, tag: String = AgentPageTags.DETAILS_ROW) {
    val colors = HappyTheme.colors
    Box(
        Modifier
            .fillMaxWidth()
            .heightIn(min = AgentPageSpec.row)
            .testTag(tag)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier.semantics(mergeDescendants = true) {}),
    ) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = AgentPageSpec.row).padding(start = AgentPageSpec.plainTextX, end = if (chevron) 8.dp else AgentPageSpec.trailing),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(title, style = AgentPageSpec.title, color = colors.text, maxLines = 1, modifier = Modifier.padding(end = 12.dp))
            Text(
                value,
                style = AgentPageSpec.title,
                color = colors.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.End,
                modifier = Modifier.weight(1f),
            )
            if (chevron) Icon(Ionicon.ChevronForward, 18.dp, colors.textSecondary, Modifier.padding(start = 6.dp))
        }
        if (!last) Divider(AgentPageSpec.plainTextX)
    }
}

/** What home's kind of row says the agent is, else what the agent itself says. */
internal fun agentKind(row: AgentFeedRow.Conversation?, subtask: Boolean?, parentAgentId: String?): AgentKind? = when (row?.kind) {
    ConversationKind.Bot -> AgentKind.Bot
    ConversationKind.Task -> AgentKind.Task
    ConversationKind.Subtask -> AgentKind.Subtask
    ConversationKind.Project -> AgentKind.Conversation
    null -> when {
        subtask == true -> AgentKind.Subtask
        parentAgentId != null -> AgentKind.Subagent
        subtask == null -> null
        else -> AgentKind.Conversation
    }
}
