package com.slopus.happy.ui.chat

import android.content.res.Resources
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.slopus.happy.R
import com.slopus.happy.chat.AgentState
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.PermissionStatus
import com.slopus.happy.chat.ToolState
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.chat.tools.PatchEntry
import com.slopus.happy.chat.tools.PatchInput
import com.slopus.happy.chat.tools.ToolIcon
import com.slopus.happy.chat.tools.ToolPresentation
import com.slopus.happy.chat.tools.ToolStatusIcon
import com.slopus.happy.chat.tools.ToolText
import com.slopus.happy.chat.tools.ToolViewKind
import com.slopus.happy.chat.tools.materializeUnifiedDiffPatch
import com.slopus.happy.chat.tools.parseToolUseError
import com.slopus.happy.chat.tools.patchChanges
import com.slopus.happy.chat.tools.patchInput
import com.slopus.happy.chat.tools.presentTool
import com.slopus.happy.chat.tools.resolvePath
import com.slopus.happy.chat.tools.resultText
import com.slopus.happy.chat.tools.taskChildTools
import com.slopus.happy.chat.tools.todoItems
import com.slopus.happy.chat.tools.unifiedDiffFileName
import com.slopus.happy.diff.DiffStats
import com.slopus.happy.diff.FileChangeKind
import com.slopus.happy.text.plural
import com.slopus.happy.text.pluralResource
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Octicon
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlin.math.roundToInt
import androidx.compose.animation.core.withInfiniteAnimationFrameMillis

object ToolTags {
    const val CARD = "tool.card"
    const val COMPACT = "tool.compact"
    const val INLINE = "tool.inline"
    const val HEADER = "tool.header"
    const val ICON = "tool.icon"
    const val TITLE = "tool.title"
    const val DESCRIPTION = "tool.description"
    const val LABEL = "tool.label"
    const val ELAPSED = "tool.elapsed"
    const val STATUS = "tool.status"
    const val CONTENT = "tool.content"
    const val SECTION = "tool.section"
    const val SECTION_TITLE = "tool.sectionTitle"
    const val ERROR = "tool.error"
    const val CODE = "tool.code"
    const val TODO = "tool.todo"
    const val TASK_ITEM = "tool.taskItem"
    const val TASK_MORE = "tool.taskMore"
    const val PLAN = "tool.plan"
    const val FILE = "tool.file"
}

/** ToolView.tsx and its parts' stylesheets. Text without a family in happy-app is the system font. */
object ToolSpec {
    val marginHorizontal = 8.dp
    val cardMarginVertical = 8.dp
    val cardRadius = 8.dp
    val compactMarginVertical = 2.dp
    val inlineMarginVertical = 1.dp
    val headerPadding = 12.dp
    val headerGap = 8.dp
    val iconBox = 24.dp
    val icon = 18.dp
    val compactMinHeight = 28.dp
    val compactPaddingHorizontal = 8.dp
    val compactPaddingVertical = 3.dp
    val compactRadius = 4.dp
    val compactGap = 10.dp
    val compactIconBox = 20.dp
    val statusIcon = 20.dp
    val spinner = 20.dp
    const val SPINNER_SCALE = 0.8f
    val name = happyTextStyle(fontSize = 14, weight = FontWeight.Medium, family = FontFamily.Default)
    val status = SpanStyle(fontWeight = FontWeight.Normal, fontSize = 15.sp)
    const val STATUS_OPACITY = 0.3f
    val description = happyTextStyle(fontSize = 13, family = FontFamily.Default)
    val descriptionMarginTop = 2.dp
    val activity = happyTextStyle(fontSize = 15, lineHeight = 20, family = FontFamily.Default)
    val elapsed = happyTextStyle(fontSize = 13, family = FontFamily.Monospace)
    val elapsedMarginStart = 8.dp
    val contentPaddingHorizontal = 12.dp
    val contentPaddingTop = 8.dp
    const val PRESSED_OPACITY = 0.8f

    val sectionMarginBottom = 12.dp
    val sectionTitle = happyTextStyle(fontSize = 13, weight = FontWeight.SemiBold, family = FontFamily.Default)
    val sectionTitleMarginBottom = 6.dp

    val errorRadius = 6.dp
    val errorPadding = 12.dp
    val errorGap = 8.dp
    val errorMaxHeight = 115.dp
    val errorIcon = 16.dp
    val errorText = happyTextStyle(fontSize = 13, family = FontFamily.Default)

    val codeRadius = 6.dp
    val codePadding = 12.dp
    val code = happyTextStyle(fontSize = 12, lineHeight = 18, family = FontFamily.Monospace)

    val todoGap = 4.dp
    val todoPaddingVertical = 2.dp
    val todoText = happyTextStyle(fontSize = 14, family = FontFamily.Default)
    val todoCompleted = Color(0xFF34C759)
    val todoInProgress = Color(0xFF007AFF)
    val todoPending = Color(0xFF666666)

    val taskPaddingTop = 4.dp
    val taskPaddingBottom = 12.dp
    val taskItemPaddingVertical = 4.dp
    val taskItemPaddingStart = 4.dp
    val taskItemPaddingEnd = 2.dp
    val taskTitle = happyTextStyle(fontSize = 14, weight = FontWeight.Medium, family = FontFamily.Monospace)
    val taskStatusPaddingStart = 8.dp
    val taskSpinner = 14.dp
    val taskStatusIcon = 16.dp
    val taskMore = happyTextStyle(fontSize = 14, family = FontFamily.Default).copy(fontStyle = FontStyle.Italic)
    const val TASK_MORE_OPACITY = 0.7f
    const val TASK_VISIBLE = 3

    val planPaddingHorizontal = 8.dp
    val planOutsetTop = 10.dp
    val multiEditGap = 8.dp
    val movePath = happyTextStyle(fontSize = 12, family = FontFamily.Monospace)
    val patchFooterPaddingHorizontal = 12.dp
    val patchFooterPaddingTop = 8.dp

    val filePaddingHorizontal = 12.dp
    val filePaddingVertical = 8.dp
    val fileGap = 4.dp
    val fileRadius = 8.dp
    val fileMaxWidth = 280f
    val fileMaxHeight = 360f
    val fileName = happyTextStyle(fontSize = 13, weight = FontWeight.Medium, family = FontFamily.Default)
}

/** What every tool row reads from the session and the settings. */
@Immutable
data class ToolEnvironment(
    val compactToolCalls: Boolean = false,
    val showLineNumbers: Boolean = false,
    /** The session's agent (`metadata.flavor`). */
    val flavor: String? = null,
    /** The session's folder, for paths in titles. */
    val path: String? = null,
    /** The session's agent state, for the forms request_user_input raised. */
    val agentState: AgentState? = null,
)

val LocalToolEnvironment = staticCompositionLocalOf { ToolEnvironment() }

/** [ToolText] over the app's resources. */
class ResourcesToolText(private val resources: Resources) : ToolText {
    override fun string(id: Int, vararg args: Any): String = resources.getString(id, *args)
    override fun plural(id: Int, count: Int, vararg args: Any): String = resources.plural(id, count, *args)
}

@Composable
fun rememberToolText(): ToolText {
    val resources = LocalContext.current.resources
    LocalConfiguration.current
    return remember(resources) { ResourcesToolText(resources) }
}

/** The glyph for a [ToolIcon] (knownTools.tsx `ICON_*`). */
@Composable
fun ToolIconView(icon: ToolIcon, size: Dp, color: Color, modifier: Modifier = Modifier) = when (icon) {
    ToolIcon.Task -> Icon(Octicon.Rocket, size, color, modifier)
    ToolIcon.Terminal -> Icon(Octicon.Terminal, size, color, modifier)
    ToolIcon.Search -> Icon(Octicon.Search, size, color, modifier)
    ToolIcon.Read -> Icon(Octicon.Eye, size, color, modifier)
    ToolIcon.Edit -> Icon(Octicon.FileDiff, size, color, modifier)
    ToolIcon.Web -> Icon(Ionicon.GlobeOutline, size, color, modifier)
    ToolIcon.Exit -> Icon(Ionicon.ExitOutline, size, color, modifier)
    ToolIcon.Todo -> Icon(Ionicon.BulbOutline, size, color, modifier)
    ToolIcon.Reasoning -> Icon(Octicon.LightBulb, size, color, modifier)
    ToolIcon.Question -> Icon(Ionicon.HelpCircleOutline, size, color, modifier)
    ToolIcon.Mcp -> Icon(Ionicon.ExtensionPuzzleOutline, size, color, modifier)
    ToolIcon.Construct -> Icon(Ionicon.ConstructOutline, size, color, modifier)
}

/**
 * ToolView.tsx, inside MessageView's tool container (8 side margins). A
 * hidden tool draws nothing. A compact tool is its activity row (transparent,
 * 2 above and below): at least 28 high, padding 8/3, radius 4, a 20 icon box
 * (18 glyph), 10 apart the activity label (15/20 textSecondary, one line),
 * the elapsed seconds while running, then the status icon. Any other tool
 * is a card (surfaceHigh, radius 8, 8 above and below): a header (padding
 * 12 on surfaceHighest, 8 apart: a 24 icon box, the title in 14 weight 500
 * with the status after it in 15 at 0.3, the subtitle below in 13
 * textSecondary 2 down, both one line; the elapsed seconds (mono 13
 * textSecondary, 8 in) while running; the status icon), then its content
 * (12 in, 8 down): the tool's own view and the error box, or the error box,
 * or INPUT and OUTPUT sections for a tool with no view. Status icons: a 0.8
 * spinner while running (unless the tool has no status), a 20
 * alert-circle-outline in the warning colour on error, a 20
 * remove-circle-outline in textSecondary when denied, cancelled or refused
 * as a tool-use error. The permission footer follows whenever the call has
 * a permission (AskUserQuestion answers in its own form). Pressing the
 * header calls [callbacks]' tool press.
 */
@Composable
fun ToolView(message: ChatMessage.ToolCallMessage, callbacks: MessageCallbacks, modifier: Modifier = Modifier) {
    val env = LocalToolEnvironment.current
    val text = rememberToolText()
    val presentation = remember(message, env, text) { presentTool(message, text, env.compactToolCalls, env.flavor, env.path) } ?: return
    val tool = message.tool
    val colors = HappyTheme.colors
    val inline = tool.name == "file"
    val tag = when {
        presentation.compact -> ToolTags.COMPACT
        inline -> ToolTags.INLINE
        else -> ToolTags.CARD
    }
    val footer: (@Composable () -> Unit)? = tool.permission?.takeIf { tool.name != "AskUserQuestion" }?.let { permission ->
        {
            PermissionFooter(
                permission = permission,
                toolName = tool.name,
                toolInput = tool.input,
                flavor = env.flavor,
                onAnswer = { answer, mode -> callbacks.onPermission(answer, mode) },
            )
        }
    }
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(
                horizontal = ToolSpec.marginHorizontal,
                vertical = when {
                    presentation.compact -> ToolSpec.compactMarginVertical
                    inline -> ToolSpec.inlineMarginVertical
                    else -> ToolSpec.cardMarginVertical
                },
            )
            .testTag(tag)
            .then(
                if (presentation.compact || inline) Modifier
                else Modifier.clip(RoundedCornerShape(ToolSpec.cardRadius)).background(colors.surfaceHigh),
            ),
    ) {
        if (presentation.renderCardHeader) {
            if (presentation.compact) CompactHeader(presentation, tool.createdAt, tool.state) { callbacks.onToolPress(message) }
            else CardHeader(presentation, tool.createdAt, tool.state) { callbacks.onToolPress(message) }
        }
        if (!presentation.compact) {
            ToolContent(message, presentation, env, callbacks, footer)
        }
        if (presentation.view != ToolViewKind.CodexPatch || presentation.compact) footer?.invoke()
    }
}

@Composable
private fun pressedAlpha(interaction: MutableInteractionSource): Float {
    val pressed by interaction.collectIsPressedAsState()
    return if (pressed) ToolSpec.PRESSED_OPACITY else 1f
}

@Composable
private fun CompactHeader(p: ToolPresentation, createdAt: Long, state: ToolState, onPress: () -> Unit) {
    val colors = HappyTheme.colors
    val interaction = remember { MutableInteractionSource() }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .testTag(ToolTags.HEADER)
            .alpha(pressedAlpha(interaction))
            .defaultMinSize(minHeight = ToolSpec.compactMinHeight)
            .clip(RoundedCornerShape(ToolSpec.compactRadius))
            .clickable(interactionSource = interaction, indication = null, onClick = onPress)
            .padding(horizontal = ToolSpec.compactPaddingHorizontal, vertical = ToolSpec.compactPaddingVertical),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(ToolSpec.compactGap),
    ) {
        ToolIconView(p.icon, ToolSpec.icon, if (p.iconSecondary) colors.textSecondary else colors.text, Modifier.size(ToolSpec.compactIconBox).testTag(ToolTags.ICON))
        Text(
            p.activityLabel,
            style = ToolSpec.activity,
            color = colors.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f).testTag(ToolTags.LABEL),
        )
        if (state == ToolState.Running) ElapsedView(createdAt, Modifier.padding(start = ToolSpec.elapsedMarginStart))
        StatusIcon(p.statusIcon)
    }
}

@Composable
private fun CardHeader(p: ToolPresentation, createdAt: Long, state: ToolState, onPress: () -> Unit) {
    val colors = HappyTheme.colors
    val interaction = remember { MutableInteractionSource() }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .testTag(ToolTags.HEADER)
            .alpha(pressedAlpha(interaction))
            .background(colors.surfaceHighest)
            .clickable(interactionSource = interaction, indication = null, onClick = onPress)
            .padding(ToolSpec.headerPadding),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(ToolSpec.headerGap),
    ) {
        ToolIconView(p.icon, ToolSpec.icon, if (p.iconSecondary) colors.textSecondary else colors.text, Modifier.size(ToolSpec.iconBox).testTag(ToolTags.ICON))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = buildAnnotatedString {
                    append(p.title)
                    if (p.status != null) {
                        withStyle(ToolSpec.status.copy(color = colors.text.copy(alpha = ToolSpec.STATUS_OPACITY))) { append(" ${p.status}") }
                    }
                },
                style = ToolSpec.name,
                color = colors.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.testTag(ToolTags.TITLE),
            )
            if (p.description != null) {
                Text(
                    p.description,
                    style = ToolSpec.description,
                    color = colors.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = ToolSpec.descriptionMarginTop).testTag(ToolTags.DESCRIPTION),
                )
            }
        }
        if (state == ToolState.Running) ElapsedView(createdAt, Modifier.padding(start = ToolSpec.elapsedMarginStart))
        StatusIcon(p.statusIcon)
    }
}

@Composable
private fun StatusIcon(icon: ToolStatusIcon) {
    val colors = HappyTheme.colors
    val modifier = Modifier.testTag(ToolTags.STATUS)
    when (icon) {
        ToolStatusIcon.None -> Unit
        ToolStatusIcon.Running -> CircularProgressIndicator(
            modifier = modifier.size(ToolSpec.spinner).scale(ToolSpec.SPINNER_SCALE),
            color = colors.text,
            strokeWidth = 2.dp,
        )
        ToolStatusIcon.Error -> Icon(Ionicon.AlertCircleOutline, ToolSpec.statusIcon, colors.warning, modifier)
        ToolStatusIcon.Removed -> Icon(Ionicon.RemoveCircleOutline, ToolSpec.statusIcon, colors.textSecondary, modifier)
    }
}

/** `ElapsedView`: whole seconds since [from], ticking each second, as "12.0s". */
@Composable
private fun ElapsedView(from: Long, modifier: Modifier = Modifier) {
    val seconds by produceState(elapsedSeconds(from), from) {
        while (true) withInfiniteAnimationFrameMillis { value = elapsedSeconds(from) }
    }
    Text(
        "%.1fs".format(seconds.toDouble()),
        style = ToolSpec.elapsed,
        color = HappyTheme.colors.textSecondary,
        maxLines = 1,
        modifier = modifier.testTag(ToolTags.ELAPSED),
    )
}

private fun elapsedSeconds(from: Long): Long = maxOf(0, (System.currentTimeMillis() - from) / 1000)

@Composable
private fun ToolContent(
    message: ChatMessage.ToolCallMessage,
    p: ToolPresentation,
    env: ToolEnvironment,
    callbacks: MessageCallbacks,
    footer: (@Composable () -> Unit)?,
) {
    val tool = message.tool
    val removed = tool.permission?.status == PermissionStatus.Denied || tool.permission?.status == PermissionStatus.Canceled
    val error = resultText(tool.result)?.takeIf { tool.state == ToolState.Error && !removed }
    val inline = tool.name == "file"
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .testTag(ToolTags.CONTENT)
            .then(if (inline) Modifier else Modifier.padding(start = ToolSpec.contentPaddingHorizontal, end = ToolSpec.contentPaddingHorizontal, top = ToolSpec.contentPaddingTop)),
    ) {
        val view = p.view
        if (view != null) {
            ToolSpecificView(view, message, env, callbacks, footer)
            if (error != null && !p.hideDefaultError) ToolError(error)
        } else if (error != null && !p.isToolUseError) {
            ToolError(error)
        } else {
            if (tool.input != null) {
                ToolSection(title = stringResource(R.string.tool_view_input)) { CodeView(prettyJson(tool.input)) }
            }
            val output = resultText(tool.result)
            if (tool.state == ToolState.Completed && output != null) {
                ToolSection(title = stringResource(R.string.tool_view_output)) {
                    CodeView(if (tool.result.str != null) output else prettyJson(tool.result!!))
                }
            }
        }
    }
}

private val PrettyJson = Json { prettyPrint = true; prettyPrintIndent = "  " }

private fun prettyJson(element: JsonElement): String = PrettyJson.encodeToString(JsonElement.serializer(), element)

@Composable
private fun ToolSpecificView(
    view: ToolViewKind,
    message: ChatMessage.ToolCallMessage,
    env: ToolEnvironment,
    callbacks: MessageCallbacks,
    footer: (@Composable () -> Unit)?,
) {
    val input = message.tool.input.obj
    when (view) {
        ToolViewKind.Edit -> {
            val edit = editStrings(input)
            ToolSection(fullWidth = true) {
                DiffChunk(DiffSource.Contents(edit?.third ?: "file.txt", edit?.first.orEmpty(), edit?.second.orEmpty()), env.showLineNumbers)
            }
        }
        ToolViewKind.Write -> {
            val path = input?.get("file_path").str
            val content = input?.get("content").str?.takeIf { path != null } ?: "<no contents>"
            ToolSection(fullWidth = true) { DiffChunk(DiffSource.Contents(path ?: "file.txt", "", content), env.showLineNumbers) }
        }
        ToolViewKind.MultiEdit -> MultiEditView(input, env)
        ToolViewKind.GeminiEdit -> {
            val (old, new, path) = geminiEditContent(message.tool.input)
            ToolSection(fullWidth = true) { DiffChunk(DiffSource.Contents(path.ifEmpty { "file.txt" }, old, new), env.showLineNumbers) }
        }
        ToolViewKind.Todo -> TodoView(message)
        ToolViewKind.ExitPlan -> {
            val plan = input?.get("plan").str ?: "<empty>"
            val blocks = remember(plan) { parseMarkdown(plan) }
            ToolSection {
                MarkdownView(blocks, Modifier.outset(top = ToolSpec.planOutsetTop).padding(horizontal = ToolSpec.planPaddingHorizontal).testTag(ToolTags.PLAN))
            }
        }
        ToolViewKind.Task -> TaskView(message)
        ToolViewKind.CodexPatch -> CodexPatchView(message, env, footer)
        ToolViewKind.CodexDiff -> CodexDiffView(input, env)
        ToolViewKind.File -> FileView(input)
        ToolViewKind.AskUserQuestion -> AskUserQuestionView(message, callbacks)
        ToolViewKind.RequestUserInput -> RequestUserInputView(message, callbacks)
        // Terminal tools are always activity rows in the chat; their command
        // view is the tool detail page's.
        ToolViewKind.Bash, ToolViewKind.CodexBash, ToolViewKind.GeminiExecute -> Unit
    }
}

/** `knownTools.Edit.input`: old, new and path, or null when the input is not an edit. */
private fun editStrings(input: Map<String, JsonElement>?): Triple<String, String, String>? {
    if (input == null) return null
    val path = input["file_path"].str ?: return null
    val old = input["old_string"].str ?: return null
    val new = input["new_string"].str ?: return null
    return Triple(old, new, path)
}

/** GeminiEditView.tsx `extractEditContent`. */
private fun geminiEditContent(input: JsonElement?): Triple<String, String, String> {
    val o = input.obj
    val content = o?.get("toolCall").obj?.get("content").arr?.firstOrNull().obj
        ?: o?.get("input").arr?.firstOrNull().obj
    if (content != null) {
        return Triple(content["oldText"].str.orEmpty(), content["newText"].str.orEmpty(), content["path"].str.orEmpty())
    }
    return Triple(
        (o?.get("oldText") ?: o?.get("old_string")).str.orEmpty(),
        (o?.get("newText") ?: o?.get("new_string")).str.orEmpty(),
        (o?.get("path") ?: o?.get("file_path")).str.orEmpty(),
    )
}

/**
 * ToolSectionView.tsx: 12 below; a title in 13 semibold textSecondary
 * uppercase, 6 above the content. Full width bleeds over the card's 12
 * side padding and 8 top padding, flush under the header.
 */
@Composable
fun ToolSection(title: String? = null, fullWidth: Boolean = false, content: @Composable () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = ToolSpec.sectionMarginBottom)
            .then(if (fullWidth) Modifier.outset(start = ToolSpec.contentPaddingHorizontal, top = ToolSpec.contentPaddingTop, end = ToolSpec.contentPaddingHorizontal) else Modifier)
            .testTag(ToolTags.SECTION),
    ) {
        if (title != null) {
            Text(
                title.uppercase(),
                style = ToolSpec.sectionTitle,
                color = HappyTheme.colors.textSecondary,
                modifier = Modifier
                    .padding(bottom = ToolSpec.sectionTitleMarginBottom)
                    .then(if (fullWidth) Modifier.padding(horizontal = ToolSpec.contentPaddingHorizontal) else Modifier)
                    .testTag(ToolTags.SECTION_TITLE),
            )
        }
        content()
    }
}

/**
 * ToolError.tsx: boxError fill and 1 border, radius 6, padding 12, 12
 * below, at most 115 high; 13 text in the box's text colour. A tool-use
 * error shows its message alone, after a 16 warning glyph, 8 apart.
 */
@Composable
fun ToolError(message: String, modifier: Modifier = Modifier) {
    val box = HappyTheme.colors.boxError
    val toolUse = parseToolUseError(message)
    val shape = RoundedCornerShape(ToolSpec.errorRadius)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(bottom = ToolSpec.sectionMarginBottom)
            .testTag(ToolTags.ERROR)
            .heightIn(max = ToolSpec.errorMaxHeight)
            .clip(shape)
            .background(box.background)
            .border(1.dp, box.border, shape)
            .padding(ToolSpec.errorPadding),
        horizontalArrangement = Arrangement.spacedBy(ToolSpec.errorGap),
    ) {
        if (toolUse != null) Icon(Ionicon.Warning, ToolSpec.errorIcon, HappyTheme.colors.boxWarning.text)
        Text(toolUse?.ifEmpty { message } ?: message, style = ToolSpec.errorText, color = box.text, modifier = Modifier.weight(1f))
    }
}

/** CodeView.tsx: surfaceHigh, radius 6, padding 12, mono 12/18 in the text colour. */
@Composable
fun CodeView(code: String, modifier: Modifier = Modifier) {
    Text(
        code,
        style = ToolSpec.code,
        color = HappyTheme.colors.text,
        modifier = modifier
            .fillMaxWidth()
            .testTag(ToolTags.CODE)
            .clip(RoundedCornerShape(ToolSpec.codeRadius))
            .background(HappyTheme.colors.surfaceHigh)
            .padding(ToolSpec.codePadding),
    )
}

/** MultiEditView.tsx: one diff per edit, 8 apart, in one full-width section; nothing without edits. */
@Composable
private fun MultiEditView(input: Map<String, JsonElement>?, env: ToolEnvironment) {
    if (input == null) return
    val path = input["file_path"].str ?: return
    val edits = input["edits"].arr?.mapNotNull { it.obj }?.takeIf { list -> list.all { it["old_string"].str != null && it["new_string"].str != null } }
    if (edits.isNullOrEmpty()) return
    ToolSection(fullWidth = true) {
        edits.forEachIndexed { index, edit ->
            // The line-number setting is not passed per edit in happy-app either.
            DiffChunk(DiffSource.Contents(path, edit["old_string"].str.orEmpty(), edit["new_string"].str.orEmpty()), showLineNumbers = true)
            if (index < edits.lastIndex) Spacer(Modifier.height(ToolSpec.multiEditGap))
        }
    }
}

/**
 * TodoView.tsx: 4 apart, each 2 above and below, 14 text "☐ item" in #666
 * when pending, #007AFF in progress, "☑ item" #34C759 struck through when
 * done. Nothing without todos.
 */
@Composable
private fun TodoView(message: ChatMessage.ToolCallMessage) {
    val todos = remember(message.tool) { todoItems(message) }
    if (todos.isEmpty()) return
    ToolSection {
        Column(verticalArrangement = Arrangement.spacedBy(ToolSpec.todoGap)) {
            for (todo in todos) {
                val completed = todo.status == "completed"
                Text(
                    text = "${if (completed) "☑" else "☐"} ${todo.content}",
                    style = ToolSpec.todoText.copy(textDecoration = if (completed) TextDecoration.LineThrough else null),
                    color = when (todo.status) {
                        "completed" -> ToolSpec.todoCompleted
                        "in_progress" -> ToolSpec.todoInProgress
                        "pending" -> ToolSpec.todoPending
                        else -> Color.Black
                    },
                    modifier = Modifier.fillMaxWidth().testTag(ToolTags.TODO).padding(vertical = ToolSpec.todoPaddingVertical),
                )
            }
        }
    }
}

/**
 * TaskView.tsx: the sub-agent's last three started tools (4 above, 12
 * below): each row 4 above and below, 4 in on the left and 2 on the right,
 * its activity label in mono 14 weight 500 textSecondary, then 8 apart a
 * 14 spinner in the warning colour, a 16 checkmark-circle in the success
 * colour, or a 16 close-circle in textDestructive; then "+N more tools"
 * (14 italic textSecondary at 0.7, padding 4). Nothing before the first.
 */
@Composable
private fun TaskView(message: ChatMessage.ToolCallMessage) {
    val text = rememberToolText()
    val tools = remember(message, text) { taskChildTools(message, text) }
    if (tools.isEmpty()) return
    val colors = HappyTheme.colors
    val remaining = maxOf(0, tools.size - ToolSpec.TASK_VISIBLE)
    Column(modifier = Modifier.fillMaxWidth().padding(top = ToolSpec.taskPaddingTop, bottom = ToolSpec.taskPaddingBottom)) {
        for ((label, state) in tools.takeLast(ToolSpec.TASK_VISIBLE)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag(ToolTags.TASK_ITEM)
                    .padding(top = ToolSpec.taskItemPaddingVertical, bottom = ToolSpec.taskItemPaddingVertical, start = ToolSpec.taskItemPaddingStart, end = ToolSpec.taskItemPaddingEnd),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(label, style = ToolSpec.taskTitle, color = colors.textSecondary, modifier = Modifier.weight(1f))
                Box(modifier = Modifier.padding(start = ToolSpec.taskStatusPaddingStart)) {
                    when (state) {
                        ToolState.Running -> CircularProgressIndicator(Modifier.size(ToolSpec.taskSpinner), color = colors.warning, strokeWidth = 2.dp)
                        ToolState.Completed -> Icon(Ionicon.CheckmarkCircle, ToolSpec.taskStatusIcon, colors.success)
                        ToolState.Error -> Icon(Ionicon.CloseCircle, ToolSpec.taskStatusIcon, colors.textDestructive)
                    }
                }
            }
        }
        if (remaining > 0) {
            Text(
                pluralResource(R.plurals.tools_task_view_more_tools, remaining, remaining),
                style = ToolSpec.taskMore,
                color = colors.textSecondary,
                modifier = Modifier
                    .testTag(ToolTags.TASK_MORE)
                    .alpha(ToolSpec.TASK_MORE_OPACITY)
                    .padding(ToolSpec.taskItemPaddingStart),
            )
        }
    }
}

/**
 * CodexPatchView.tsx: per file, a full-width section on the surface colour
 * with the diff header (path relative to the session, NEW / DELETED /
 * RENAMED, +/− counts; the destination of a move under it in mono 12
 * textSecondary, 12 in, 9 below) and the file's diff; the permission
 * footer after the last file, 12 in and 8 down. A patch whose files cannot
 * be read shows "Update file" over the raw patch.
 */
@Composable
private fun CodexPatchView(message: ChatMessage.ToolCallMessage, env: ToolEnvironment, footer: (@Composable () -> Unit)?) {
    val tool = message.tool
    val changes = remember(tool.input) { patchChanges(tool.input)?.entries?.toList().orEmpty() }
    val error = resultText(tool.result)?.takeIf { tool.state == ToolState.Error }
    if (changes.isEmpty()) {
        val input = tool.input.obj
        val raw = input?.get("patch").str ?: input?.get("input").str ?: resultText(tool.input)
        ToolSection(title = stringResource(R.string.tools_names_apply_changes)) {
            if (error != null) ToolError(error)
            if (raw != null) CodeView(raw)
            footer?.invoke()
        }
        return
    }
    if (error != null) ToolError(error)
    changes.forEachIndexed { index, (file, change) ->
        PatchFile(file, change, env, if (index == changes.lastIndex) footer else null)
    }
}

@Composable
private fun PatchFile(file: String, change: PatchEntry, env: ToolEnvironment, footer: (@Composable () -> Unit)?) {
    val palette = if (HappyTheme.colors.dark) DarkDiffPalette else LightDiffPalette
    val path = resolvePath(file, env.path)
    val movePath = change.movePath?.let { resolvePath(it, env.path) }
    val fileName = file.substringAfterLast('/')
    val diff = remember(change, file) {
        when (val input = patchInput(change)) {
            is PatchInput.Patch -> {
                val patch = materializeUnifiedDiffPatch(input.patch, file, change.kindType)
                DiffSource.Patch(patch) to DiffStats.countPatch(patch)
            }
            is PatchInput.Pair -> (if (input.oldText.isEmpty() && input.newText.isEmpty()) null else DiffSource.Contents(fileName, input.oldText, input.newText)) to
                DiffStats.countContents(input.oldText, input.newText)
            null -> null to null
        }
    }
    ToolSection(fullWidth = true) {
        Column(modifier = Modifier.fillMaxWidth().background(HappyTheme.colors.surface).testTag(ToolTags.FILE)) {
            Column(modifier = Modifier.background(palette.hunkBg)) {
                DiffFileHeader(
                    path = path,
                    kind = when {
                        movePath != null -> FileChangeKind.Renamed
                        change.kindType == "add" -> FileChangeKind.Added
                        change.kindType == "delete" -> FileChangeKind.Deleted
                        else -> FileChangeKind.Modified
                    },
                    additions = diff.second?.additions ?: 0,
                    deletions = diff.second?.deletions ?: 0,
                )
                if (movePath != null) {
                    Text(
                        movePath,
                        style = ToolSpec.movePath,
                        color = HappyTheme.colors.textSecondary,
                        modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 9.dp),
                    )
                }
            }
            diff.first?.let { DiffChunk(it, env.showLineNumbers) }
            if (footer != null) {
                Box(modifier = Modifier.padding(start = ToolSpec.patchFooterPaddingHorizontal, end = ToolSpec.patchFooterPaddingHorizontal, top = ToolSpec.patchFooterPaddingTop)) {
                    footer()
                }
            }
        }
    }
}

/** CodexDiffView.tsx: the `unified_diff` under a header naming the file; nothing without a diff. */
@Composable
private fun CodexDiffView(input: Map<String, JsonElement>?, env: ToolEnvironment) {
    if (input == null) return
    val patch = input["unified_diff"].str ?: return
    val fileName = (input["path"] ?: input["filePath"]).str ?: unifiedDiffFileName(patch)
    val stats = remember(patch) { DiffStats.countPatch(patch) }
    ToolSection(fullWidth = true) {
        if (fileName != null) DiffFileHeader(fileName, FileChangeKind.Modified, stats.additions, stats.deletions)
        DiffChunk(DiffSource.Patch(patch), env.showLineNumbers)
    }
}

/**
 * FileView.tsx: an attached picture, at most 280 wide and 360 high in its
 * own aspect (4:3 without one), radius 8, 12 in and 8 above and below, its
 * name under it 4 down in 13 weight 500 textSecondary. Until attachments
 * download, the picture's box is drawn in surfaceHigh.
 */
@Composable
private fun FileView(input: Map<String, JsonElement>?) {
    if (input == null) return
    val name = input["name"].str ?: return
    if (input["ref"].str == null) return
    val image = input["image"].obj
    val w = (image?.get("width") as? kotlinx.serialization.json.JsonPrimitive)?.content?.toFloatOrNull()
    val h = (image?.get("height") as? kotlinx.serialization.json.JsonPrimitive)?.content?.toFloatOrNull()
    val aspect = if (w != null && h != null && w > 0 && h > 0) w / h else 4f / 3f
    var displayW = minOf(if (w != null && w > 0) w else ToolSpec.fileMaxWidth, ToolSpec.fileMaxWidth)
    var displayH = displayW / aspect
    if (displayH > ToolSpec.fileMaxHeight) {
        displayH = ToolSpec.fileMaxHeight
        displayW = displayH * aspect
    }
    Column(
        modifier = Modifier.padding(horizontal = ToolSpec.filePaddingHorizontal, vertical = ToolSpec.filePaddingVertical),
        verticalArrangement = Arrangement.spacedBy(ToolSpec.fileGap),
    ) {
        Box(
            modifier = Modifier
                .size(displayW.roundToInt().dp, displayH.roundToInt().dp)
                .clip(RoundedCornerShape(ToolSpec.fileRadius))
                .background(HappyTheme.colors.surfaceHigh)
                .testTag(ToolTags.FILE),
        )
        Text(name, style = ToolSpec.fileName, color = HappyTheme.colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
