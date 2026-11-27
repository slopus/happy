package com.slopus.happy.ui.bots

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavHostController
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.agent.BotEditForm
import com.slopus.happy.agent.BotEditor
import com.slopus.happy.agent.Permission
import com.slopus.happy.agent.botEditable
import com.slopus.happy.agent.string
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.ItemSpec
import com.slopus.happy.ui.components.PageProgressIndicator
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.components.avatar.PlaceholderAvatar
import com.slopus.happy.ui.connection.AgentPicture
import com.slopus.happy.ui.connection.LocalAgentPictures
import com.slopus.happy.ui.connection.rememberPhoto
import com.slopus.happy.ui.connection.rememberProfilePhotoPicker
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** An editable bot's settings: its name, picture and instructions (happy-cluster `PATCH /v0/bots/:id`). */
@Serializable data class BotSettingsRoute(val connectionId: String, val botId: String)

object BotSettingsTags {
    const val SCREEN = "botSettings.screen"
    const val LOADING = "botSettings.loading"
    const val PICTURE = "botSettings.picture"
    const val CHANGE_PHOTO = "botSettings.changePhoto"
    const val REMOVE_PHOTO = "botSettings.removePhoto"
    const val NAME = "botSettings.name"
    const val INSTRUCTIONS = "botSettings.instructions"
    const val SAVE = "botSettings.save"
}

/** ProfileLayout.swift's picture and button, the picture a bot's rounded square (0.22 of its side, as the agent page's). */
object BotSettingsSpec {
    val pictureTop = 16.dp
    val picture = 100.dp
    val pictureRadius = 22.dp
    val buttonGap = 8.dp
    val buttonHeight = 32.dp
    val buttonPadding = 12.dp
    val cardsGap = 4.dp
    /** The instructions' field: room for a few lines before it grows. */
    val instructionsMin = 160.dp
}

/** What the page shows: [form] null until the bot is read; [picked] a picture on its way up. */
@Immutable
data class BotSettingsState(
    val botId: String,
    val form: BotEditForm? = null,
    val picture: String? = null,
    val thumbhash: String? = null,
    val saving: Boolean = false,
    val photoBusy: Boolean = false,
    /** The bot is no longer the person's to change: everything reads only. */
    val editable: Boolean = true,
)

/**
 * The bot this page edits, as last heard (its read, `bot.updated` through
 * the catalog, each answer), and the form over it. Changes go one at a time
 * through [BotEditor]; each answer goes to the catalog too, so home wears it
 * at once.
 */
internal class BotSettingsModel(private val session: AgentSession, private val botId: String) : ViewModel() {
    /** Why a change didn't go: [save] the form's, else the picture's; [message] the server's words, ours where the role was refused ([forbidden]). */
    data class Failure(val save: Boolean, val removing: Boolean, val message: String? = null, val forbidden: Boolean = false)

    private val editor = BotEditor(session.client, botId)
    private var bot: JsonObject? = null
    private val stateFlow = MutableStateFlow(BotSettingsState(botId))
    val state: StateFlow<BotSettingsState> = stateFlow.asStateFlow()
    private val pickedFlow = MutableStateFlow<ByteArray?>(null)
    val picked: StateFlow<ByteArray?> = pickedFlow.asStateFlow()
    private val failureFlow = MutableStateFlow<Failure?>(null)
    val failure: StateFlow<Failure?> = failureFlow.asStateFlow()

    init {
        viewModelScope.launch {
            // The form waits for the bot itself: its instructions may not be in the catalog's copy.
            try {
                editor.read().also(session::upsertBot).let(::heard)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                session.catalog.value.bots[botId]?.let(::heard)
            }
            session.catalog.map { it.bots[botId] }.distinctUntilChanged().collect { it?.let(::heard) }
        }
    }

    /** [next] unless an older copy than the one shown; its instructions kept where it leaves them out ([BotEditForm.heard]). */
    private fun heard(next: JsonObject) {
        val shown = bot
        if (shown != null && (next.string("version") ?: "") < (shown.string("version") ?: "")) return
        bot = next
        val avatar = next["avatar"] as? JsonObject
        stateFlow.update {
            it.copy(
                form = it.form?.heard(next) ?: BotEditForm.of(next),
                picture = avatar?.let { "/v0/bots/${AgentClient.escape(botId)}/avatar" },
                thumbhash = avatar?.string("thumbhash"),
                editable = botEditable(next),
            )
        }
    }

    fun edit(change: (BotEditForm) -> BotEditForm) = stateFlow.update { state -> state.form?.let { state.copy(form = change(it)) } ?: state }

    fun save() {
        val state = stateFlow.value
        val form = state.form?.takeIf { it.canSave } ?: return
        val version = bot?.string("version") ?: return
        if (state.saving) return
        stateFlow.update { it.copy(saving = true) }
        attempt(Failure(save = true, removing = false)) { editor.save(form, version) }
    }

    fun setPhoto(jpeg: ByteArray) {
        val version = bot?.string("version") ?: return
        if (stateFlow.value.photoBusy) return
        pickedFlow.value = jpeg
        stateFlow.update { it.copy(photoBusy = true) }
        attempt(Failure(save = false, removing = false)) { editor.setAvatar(jpeg, version) }
    }

    fun removePhoto() {
        val version = bot?.string("version") ?: return
        if (stateFlow.value.photoBusy) return
        stateFlow.update { it.copy(photoBusy = true) }
        attempt(Failure(save = false, removing = true)) { editor.removeAvatar(version) }
    }

    fun dismissFailure() { failureFlow.value = null }

    private fun attempt(failure: Failure, change: suspend () -> JsonObject) {
        viewModelScope.launch {
            try {
                change().also(session::upsertBot).let(::heard)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val refused = e is AgentApiException && Permission.refused(e.status, e.code, e.message)
                failureFlow.value = failure.copy(message = e.message, forbidden = refused)
            } finally {
                pickedFlow.value = null
                stateFlow.update { it.copy(saving = false, photoBusy = false) }
            }
        }
    }
}

/**
 * An editable bot's settings, Settings › Profile's look (iOS's
 * ProfileViewController) for a bot: its picture (else the placeholder its
 * ID picks), a 100 rounded square centred 16 under the bar, "Change Photo"
 * in the link colour 8 under it (the system photo picker; a tap on the
 * picture does the same), its name as a field in a card, then its
 * instructions under their heading, a multiline field at least 160 high
 * with a footer saying when a change takes effect, or what keeps it from
 * saving; "Remove Photo" in a card of its own while there is a picture.
 * Save in the bar sends the name and instructions changed, once both are
 * valid; a picture goes as soon as it is picked. Back with unsaved changes
 * asks first. Until the bot is read, a spinner.
 */
@Composable
fun BotSettingsScreen(
    state: BotSettingsState,
    photo: ImageBitmap?,
    onEdit: ((BotEditForm) -> BotEditForm) -> Unit,
    onSave: () -> Unit,
    onChangePhoto: () -> Unit,
    onRemovePhoto: () -> Unit,
    onBack: () -> Unit,
) {
    val colors = HappyTheme.colors
    val focus = LocalFocusManager.current
    val form = state.form
    val editable = state.editable && !state.saving
    var asking by remember { mutableStateOf(false) }
    val dirty = form?.changed == true
    BackHandler(enabled = dirty) { asking = true }
    Screen(
        header = {
            StackHeader(stringResource(R.string.bot_settings_title), { if (dirty) asking = true else onBack() }) {
                if (form != null && state.editable) {
                    TextButton(onClick = onSave, enabled = form.canSave && !state.saving, modifier = Modifier.testTag(BotSettingsTags.SAVE)) {
                        Text(stringResource(R.string.common_save))
                    }
                }
            }
        },
        avoidKeyboard = true,
        modifier = Modifier.testTag(BotSettingsTags.SCREEN),
    ) {
        if (form == null) {
            Box(Modifier.align(Alignment.Center).testTag(BotSettingsTags.LOADING)) { PageProgressIndicator() }
            return@Screen
        }
        ItemList {
            Column(
                Modifier.fillMaxWidth().padding(top = BotSettingsSpec.pictureTop, bottom = BotSettingsSpec.cardsGap),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                val shape = RoundedCornerShape(BotSettingsSpec.pictureRadius)
                Box(
                    Modifier
                        .size(BotSettingsSpec.picture)
                        .clip(shape)
                        .clickable(enabled = state.editable && !state.photoBusy, role = Role.Button, onClick = onChangePhoto)
                        .testTag(BotSettingsTags.PICTURE),
                ) {
                    val picture = state.picture
                    when {
                        photo != null -> Image(photo, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(BotSettingsSpec.picture))
                        picture != null -> AgentPicture(picture, state.thumbhash, BotSettingsSpec.picture, BotSettingsSpec.pictureRadius)
                        else -> PlaceholderAvatar(state.botId, BotSettingsSpec.picture, shape = shape)
                    }
                }
                if (state.editable) {
                    Box(
                        Modifier
                            .padding(top = BotSettingsSpec.buttonGap)
                            .heightIn(min = BotSettingsSpec.buttonHeight)
                            .clip(RoundedCornerShape(8.dp))
                            .clickable(enabled = !state.photoBusy, role = Role.Button, onClick = onChangePhoto)
                            .testTag(BotSettingsTags.CHANGE_PHOTO)
                            .padding(horizontal = BotSettingsSpec.buttonPadding),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(stringResource(R.string.settings_change_photo), style = ItemSpec.title, color = colors.textLink)
                    }
                }
            }
            val problem = form.problem.takeIf { form.changed }
            ItemGroup(footer = nameProblem(problem)) {
                FormField(
                    value = form.name,
                    onValueChange = { name -> onEdit { it.copy(name = name) } },
                    placeholder = stringResource(R.string.settings_account_name),
                    readOnly = !editable,
                    singleLine = true,
                    tag = BotSettingsTags.NAME,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, autoCorrectEnabled = false, imeAction = ImeAction.Next),
                    keyboardActions = KeyboardActions(onNext = { focus.moveFocus(androidx.compose.ui.focus.FocusDirection.Down) }),
                )
            }
            ItemGroup(
                title = stringResource(R.string.bot_settings_instructions),
                footer = if (problem == BotEditForm.Problem.InstructionsTooLong) {
                    stringResource(R.string.policy_too_long, BotEditForm.INSTRUCTIONS_MAX_BYTES / 1024)
                } else {
                    stringResource(R.string.bot_settings_instructions_footer)
                },
            ) {
                FormField(
                    value = form.instructions,
                    onValueChange = { text -> onEdit { it.copy(instructions = text) } },
                    placeholder = stringResource(R.string.bot_settings_instructions_placeholder),
                    readOnly = !editable,
                    singleLine = false,
                    tag = BotSettingsTags.INSTRUCTIONS,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    minHeight = BotSettingsSpec.instructionsMin,
                )
            }
            if (state.editable && state.picture != null) {
                ItemGroup {
                    Item(
                        title = stringResource(R.string.settings_remove_photo),
                        destructive = true,
                        showChevron = false,
                        onClick = if (state.photoBusy) null else onRemovePhoto,
                        modifier = Modifier.testTag(BotSettingsTags.REMOVE_PHOTO),
                    )
                }
            }
        }
    }
    if (asking) {
        HappyAlert(
            Alert(
                stringResource(R.string.policy_discard_title),
                buttons = listOf(
                    AlertButton(stringResource(R.string.policy_keep_editing)),
                    AlertButton(stringResource(R.string.policy_discard), destructive = true) { onBack() },
                ),
            ),
            onDismiss = { asking = false },
        )
    }
}

/** What keeps the name from saving, as its card's footer; null for nothing. */
@Composable
private fun nameProblem(problem: BotEditForm.Problem?): String? = when (problem) {
    BotEditForm.Problem.NameBlank -> stringResource(R.string.bot_settings_name_blank)
    BotEditForm.Problem.NameTooLong -> stringResource(R.string.bot_settings_name_too_long, BotEditForm.NAME_MAX)
    BotEditForm.Problem.NameControl -> stringResource(R.string.bot_settings_name_control)
    BotEditForm.Problem.InstructionsTooLong, null -> null
}

/** A field filling its card, Settings › Profile's name field's type and insets, [placeholder] until typed. */
@Composable
private fun FormField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    readOnly: Boolean,
    singleLine: Boolean,
    tag: String,
    keyboardOptions: KeyboardOptions,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    minHeight: androidx.compose.ui.unit.Dp = ItemSpec.minHeight,
) {
    val colors = HappyTheme.colors
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        readOnly = readOnly,
        singleLine = singleLine,
        textStyle = ItemSpec.title.copy(color = colors.text),
        cursorBrush = SolidColor(colors.textLink),
        keyboardOptions = keyboardOptions,
        keyboardActions = keyboardActions,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = minHeight)
            .testTag(tag)
            .padding(horizontal = ItemSpec.paddingHorizontal, vertical = ItemSpec.paddingVertical),
        decorationBox = { field ->
            Box {
                if (value.isEmpty()) Text(placeholder, style = ItemSpec.title, color = colors.textSecondary)
                field()
            }
        },
    )
}

/** [route]'s page: the bot read, edited and saved through [BotSettingsModel]. */
@Composable
internal fun BotSettingsEntry(graph: AppGraph, nav: NavHostController, route: BotSettingsRoute) {
    val session = remember(route.connectionId) { graph.agentSessions.session(route.connectionId) } ?: return
    val model = viewModel(key = "botSettings.${route.botId}") { BotSettingsModel(session, route.botId) }
    val state by model.state.collectAsStateWithLifecycle()
    val photo = rememberPhoto(model.picked.collectAsStateWithLifecycle().value)
    val failure by model.failure.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val ok = stringResource(R.string.common_ok)
    val couldNotChange = stringResource(R.string.settings_could_not_change_photo)
    var unreadable by remember { mutableStateOf<String?>(null) }
    val choosePhoto = rememberProfilePhotoPicker(onPicked = model::setPhoto, onFailed = { unreadable = it.message.orEmpty() })
    CompositionLocalProvider(LocalAgentPictures provides session.pictures) {
        BotSettingsScreen(
            state = state,
            photo = photo,
            onEdit = model::edit,
            onSave = model::save,
            onChangePhoto = choosePhoto,
            onRemovePhoto = model::removePhoto,
            onBack = { nav.popBackStack() },
        )
    }
    failure?.let { failed ->
        val title = when {
            failed.save -> stringResource(R.string.bot_settings_could_not_save)
            failed.removing -> stringResource(R.string.settings_could_not_remove_photo)
            else -> couldNotChange
        }
        HappyAlert(Alert(title, if (failed.forbidden) context.getString(R.string.problem_forbidden) else failed.message.orEmpty(), listOf(AlertButton(ok))), onDismiss = model::dismissFailure)
    }
    unreadable?.let { HappyAlert(Alert(couldNotChange, it, listOf(AlertButton(ok))), onDismiss = { unreadable = null }) }
}
