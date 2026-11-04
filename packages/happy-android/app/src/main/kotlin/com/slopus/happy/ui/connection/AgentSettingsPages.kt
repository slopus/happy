package com.slopus.happy.ui.connection

import com.slopus.happy.ui.tablet.BackOrSidebarToggle
import com.slopus.happy.ui.page
import com.slopus.happy.ui.components.ProvideRowReveal
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.produceState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import com.slopus.happy.payments.OfferSheet
import com.slopus.happy.payments.RestoreResult
import com.slopus.happy.ui.call.RestoreAlert
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
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
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.AgentProfileState
import com.slopus.happy.agent.CompletionSound
import com.slopus.happy.agent.PersonSeed
import com.slopus.happy.attachments.ProfilePhoto
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.Avatar
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.ItemSpec
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.settings.SettingsCard
import com.slopus.happy.ui.settings.SettingsEntry
import com.slopus.happy.ui.settings.SettingsSection
import com.slopus.happy.ui.settings.SettingsTile
import com.slopus.happy.ui.settings.SettingsTiles
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

/** An agent connection's Appearance: the theme and the desktop's Hide projects; [reveal] as on settings. */
@Serializable data class AgentAppearanceRoute(val connectionId: String, val reveal: String? = null)

/** The person's own profile on an agent connection. */
@Serializable data class AgentProfileRoute(val connectionId: String)

internal fun NavGraphBuilder.agentSettingsPages(graph: AppGraph, nav: NavHostController) {
    page<AgentAppearanceRoute> { entry ->
        val route = entry.toRoute<AgentAppearanceRoute>()
        val id = route.connectionId
        val session = remember(id) { graph.agentSessions.session(id) }
        val theme by graph.localSettings.themePreference.collectAsStateWithLifecycle()
        val hidden = session?.projectsHidden?.collectAsStateWithLifecycle()?.value ?: false
        val sound = session?.completionSound?.collectAsStateWithLifecycle()?.value ?: CompletionSound.Always
        ProvideRowReveal(route.reveal) {
            AgentAppearanceScreen(
                theme = theme,
                onTheme = graph.localSettings::setThemePreference,
                projectsHidden = hidden,
                onProjectsHidden = { session?.setProjectsHidden(it) },
                onBack = { nav.popBackStack() },
                completionSound = sound,
                onCompletionSound = { session?.setCompletionSound(it) },
            )
        }
    }
    page<AgentVoiceRoute> { entry ->
        val scope = rememberCoroutineScope()
        var restored by remember { mutableStateOf<RestoreResult?>(null) }
        ProvideRowReveal(entry.toRoute<AgentVoiceRoute>().reveal) {
            AgentVoiceScreen(
                rememberAgentVoiceSummary(graph.offers, graph.subscription),
                onSubscribe = { graph.offers.show(OfferSheet.Support(graph.offers.offer)) },
                onRestore = { scope.launch { restored = graph.offers.restore() } },
                onBack = { nav.popBackStack() },
            )
        }
        restored?.let { RestoreAlert(it) { restored = null } }
    }
    page<AgentDataStorageRoute> { entry -> AgentDataStorage(graph, nav, entry.toRoute<AgentDataStorageRoute>().connectionId) }
    page<AgentSharingRoute> { entry ->
        val id = entry.toRoute<AgentSharingRoute>().connectionId
        val session = remember(id) { graph.agentSessions.session(id) }
        val state = session?.sharing?.collectAsStateWithLifecycle()?.value ?: com.slopus.happy.agent.AgentSharingState.Loading
        AgentSharingScreen(state, { kind, enabled -> session?.setAutoJoin(kind, enabled) }, { nav.popBackStack() })
    }
    page<AgentProfileRoute> { entry ->
        val id = entry.toRoute<AgentProfileRoute>().connectionId
        val source = remember(id) { graph.agentSessions.session(id)?.profile } ?: return@page
        AgentProfile(source, rememberPersonSeed(graph, id), onBack = { nav.popBackStack() })
    }
}

/** A person's seed follows the catalog's team user, independently of the computer's own avatar. */
@Composable
internal fun rememberPersonSeed(graph: AppGraph, connectionId: String): String {
    val session = remember(graph, connectionId) { graph.agentSessions.session(connectionId) }
    val user by remember(session) {
        session?.catalog?.map { it.userId }?.distinctUntilChanged() ?: flowOf(null)
    }.collectAsStateWithLifecycle(initialValue = remember(session) { session?.catalog?.value?.userId })
    val computer by produceState<String?>(null, graph, connectionId) {
        value = graph.agentConnections.placeholderSeed(connectionId)
    }
    return PersonSeed.seed(user, "person:${computer ?: connectionId}")
}

object AgentPagesTags {
    const val BAR = "agentPages.bar"
    fun theme(theme: ThemePreference) = "agentPages.theme.${theme.name}"
    const val HIDE_PROJECTS = "agentPages.hideProjects"
    const val HIDE_PROJECTS_ROW = "agentPages.hideProjectsRow"
    fun sound(sound: CompletionSound) = "agentPages.sound.${sound.name}"
    const val PICTURE = "agentPages.picture"
    const val CHANGE_PHOTO = "agentPages.changePhoto"
    const val NAME = "agentPages.name"
    const val REMOVE_PHOTO = "agentPages.removePhoto"
}

/** A page under an agent connection's Settings: its bar on the page's own grey, as Settings' is. */
@Composable
internal fun AgentPage(title: String, onBack: () -> Unit, content: @Composable () -> Unit) {
    Screen(
        header = {
            AgentTopBar(
                tag = AgentPagesTags.BAR,
                container = HappyTheme.colors.grouped.background,
                navigationIcon = { BackOrSidebarToggle { BarIconButton(Ionicon.ArrowBack, stringResource(R.string.common_back), onBack) } },
                title = { Text(title, style = MaterialTheme.typography.titleLarge, maxLines = 1) },
            )
        },
    ) {
        ItemList { content() }
    }
}

/**
 * A connection's look on this phone (iOS's `appearanceRows`): the theme,
 * Adaptive, Light or Dark with a check on the chosen one; and Hide projects,
 * the desktop's own setting, which home follows here and Happy Desktop
 * there. Deliberately no renderer or layout choice. Then desktop's
 * Completion sound (Always, When focused, Never), the connection's own
 * setting too, which the chime follows here ([com.slopus.happy.agent.CompletionWatch]).
 */
@Composable
fun AgentAppearanceScreen(
    theme: ThemePreference,
    onTheme: (ThemePreference) -> Unit,
    projectsHidden: Boolean,
    onProjectsHidden: (Boolean) -> Unit,
    onBack: () -> Unit,
    completionSound: CompletionSound = CompletionSound.Always,
    onCompletionSound: (CompletionSound) -> Unit = {},
) {
    val sections = agentAppearanceSections(theme, onTheme, projectsHidden, onProjectsHidden, completionSound, onCompletionSound)
    AgentPage(stringResource(R.string.settings_appearance), onBack) {
        for (section in sections) SettingsCard(section)
    }
}

/** Appearance's rows, which its page draws and Settings' search finds: see [AgentAppearanceScreen]. */
@Composable
fun agentAppearanceSections(
    theme: ThemePreference,
    onTheme: (ThemePreference) -> Unit,
    projectsHidden: Boolean,
    onProjectsHidden: (Boolean) -> Unit,
    completionSound: CompletionSound = CompletionSound.Always,
    onCompletionSound: (CompletionSound) -> Unit = {},
): List<SettingsSection> = listOf(
    SettingsSection(
        listOf(
            ThemePreference.Adaptive to R.string.settings_appearance_theme_options_adaptive,
            ThemePreference.Light to R.string.settings_appearance_theme_options_light,
            ThemePreference.Dark to R.string.settings_appearance_theme_options_dark,
        ).map { (option, name) ->
            SettingsEntry(
                id = AgentPagesTags.theme(option),
                title = stringResource(name),
                checked = option == theme,
                chevron = false,
                onClick = { onTheme(option) },
            )
        },
    ),
    SettingsSection(
        listOf(
            SettingsEntry(
                id = AgentPagesTags.HIDE_PROJECTS_ROW,
                title = stringResource(R.string.settings_hide_projects),
                icon = { SettingsTile(Ionicon.FolderOutline, SettingsTiles.orange) },
                toggle = projectsHidden,
                onToggle = onProjectsHidden,
                toggleTag = AgentPagesTags.HIDE_PROJECTS,
                chevron = false,
            ),
        ),
        footer = stringResource(R.string.settings_hide_projects_footer),
    ),
    SettingsSection(
        listOf(
            CompletionSound.Always to R.string.agent_settings_completion_sound_always,
            CompletionSound.Focused to R.string.agent_settings_completion_sound_focused,
            CompletionSound.Never to R.string.agent_settings_completion_sound_never,
        ).map { (option, name) ->
            SettingsEntry(
                id = AgentPagesTags.sound(option),
                title = stringResource(name),
                checked = option == completionSound,
                chevron = false,
                onClick = { onCompletionSound(option) },
            )
        },
        footer = stringResource(R.string.agent_settings_completion_sound_footer),
        title = stringResource(R.string.agent_settings_completion_sound),
    ),
)

/** ProfileLayout.swift. */
object AgentProfileSpec {
    val pictureTop = 16.dp
    val picture = 100.dp
    val buttonGap = 8.dp
    val buttonHeight = 32.dp
    val buttonPadding = 12.dp
    /** To the first card: 20 in all, [ItemGroup]'s 16 spacer included. */
    val cardsGap = 4.dp
}

/**
 * The person's own profile on a paired agent (iOS's ProfileViewController):
 * their picture (else the one the connection's id picks) 100 round and
 * centred 16 under the bar, "Change Photo" in the link colour 8 under it
 * (the system photo picker; a tap on the picture does the same), then the
 * name as a field in a card, saved when it is done (an empty one shows the
 * name again), and "Remove Photo" in a card of its own while there is a
 * picture. A change shows at once; a failure says so.
 */
@Composable
fun AgentProfileScreen(
    seed: String,
    state: AgentProfileState,
    photo: ImageBitmap?,
    onRename: (String) -> Unit,
    onChangePhoto: () -> Unit,
    onRemovePhoto: () -> Unit,
    onBack: () -> Unit,
) {
    val colors = HappyTheme.colors
    val focus = LocalFocusManager.current
    var text by rememberSaveable(state.name) { mutableStateOf(state.name) }
    var editing by remember { mutableStateOf(false) }
    fun commit() {
        val name = text.trim()
        if (name.isEmpty() || name == state.name) text = state.name else onRename(name)
    }
    AgentPage(stringResource(R.string.settings_account_profile), onBack) {
        Column(Modifier.fillMaxWidth().padding(top = AgentProfileSpec.pictureTop, bottom = AgentProfileSpec.cardsGap), horizontalAlignment = Alignment.CenterHorizontally) {
            Box(
                Modifier
                    .size(AgentProfileSpec.picture)
                    .clip(CircleShape)
                    .clickable(role = Role.Button, onClick = onChangePhoto)
                    .testTag(AgentPagesTags.PICTURE),
            ) {
                if (photo != null) {
                    Image(photo, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(AgentProfileSpec.picture))
                } else {
                    Avatar(seed, AgentProfileSpec.picture)
                }
            }
            Box(
                Modifier
                    .padding(top = AgentProfileSpec.buttonGap)
                    .heightIn(min = AgentProfileSpec.buttonHeight)
                    .clip(RoundedCornerShape(8.dp))
                    .clickable(role = Role.Button, onClick = onChangePhoto)
                    .testTag(AgentPagesTags.CHANGE_PHOTO)
                    .padding(horizontal = AgentProfileSpec.buttonPadding),
                contentAlignment = Alignment.Center,
            ) {
                Text(stringResource(R.string.settings_change_photo), style = ItemSpec.title, color = colors.textLink)
            }
        }
        ItemGroup {
            BasicTextField(
                value = text,
                onValueChange = { text = it },
                singleLine = true,
                textStyle = ItemSpec.title.copy(color = colors.text),
                cursorBrush = SolidColor(colors.textLink),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, autoCorrectEnabled = false, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { focus.clearFocus() }),
                modifier = Modifier
                    .fillMaxWidth()
                    .defaultMinSize(minHeight = ItemSpec.minHeight)
                    .onFocusChanged { if (editing && !it.isFocused) commit(); editing = it.isFocused }
                    .testTag(AgentPagesTags.NAME)
                    .padding(horizontal = ItemSpec.paddingHorizontal, vertical = ItemSpec.paddingVertical),
                decorationBox = { field ->
                    Box {
                        if (text.isEmpty()) Text(stringResource(R.string.settings_account_name), style = ItemSpec.title, color = colors.textSecondary)
                        field()
                    }
                },
            )
        }
        if (state.hasPhoto) {
            ItemGroup {
                Item(
                    title = stringResource(R.string.settings_remove_photo),
                    destructive = true,
                    showChevron = false,
                    onClick = onRemovePhoto,
                    modifier = Modifier.testTag(AgentPagesTags.REMOVE_PHOTO),
                )
            }
        }
    }
}

@Composable
private fun AgentProfile(source: com.slopus.happy.agent.AgentProfileSource, seed: String, onBack: () -> Unit) {
    val state by source.state.collectAsStateWithLifecycle()
    val photo = rememberPhoto(source.photo.collectAsStateWithLifecycle().value)
    // Every time it shows, not only when the agent says so.
    LaunchedEffect(source) { source.refresh() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var alert by remember { mutableStateOf<Alert?>(null) }
    val ok = stringResource(R.string.common_ok)
    val couldNotSave = stringResource(R.string.settings_could_not_save_profile)
    val couldNotChange = stringResource(R.string.settings_could_not_change_photo)
    val couldNotRemove = stringResource(R.string.settings_could_not_remove_photo)
    fun attempt(title: String, block: suspend () -> Unit) {
        scope.launch {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                alert = Alert(title, e.message ?: "", listOf(AlertButton(ok)))
            }
        }
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        attempt(couldNotChange) {
            val jpeg = withContext(Dispatchers.IO) { ProfilePhoto.prepare { context.contentResolver.openInputStream(uri) ?: throw java.io.IOException("Unreadable") } }
            source.setPhoto(jpeg)
        }
    }
    AgentProfileScreen(
        seed = seed,
        state = state,
        photo = photo,
        onRename = { name -> attempt(couldNotSave) { source.rename(name) } },
        onChangePhoto = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
        onRemovePhoto = { attempt(couldNotRemove) { source.removePhoto() } },
        onBack = onBack,
    )
    alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
}
