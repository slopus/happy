package com.slopus.happy.ui.plugins

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.plugins.Installability
import com.slopus.happy.plugins.InstallationStatus
import com.slopus.happy.plugins.Plugin
import com.slopus.happy.plugins.PluginAuthMethod
import com.slopus.happy.plugins.PluginConnection
import com.slopus.happy.plugins.PluginInstallation
import com.slopus.happy.plugins.PluginRefusal
import com.slopus.happy.plugins.PluginsException
import com.slopus.happy.plugins.PluginsSnapshot
import com.slopus.happy.plugins.PluginsState
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.HappyTextField
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.RoundButtonDisplay
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException

object PluginActionTags {
    const val INSTALL = "plugins.install"
    const val REMOVE = "plugins.remove"
    const val DISCONNECT = "plugins.disconnect"
    const val SAVE = "plugins.save"
    const val BROWSER_NOTE = "plugins.browserNote"
    fun method(id: String) = "plugins.method.$id"
    fun field(key: String) = "plugins.field.$key"
    fun fieldError(key: String) = "plugins.fieldError.$key"
    fun connection(id: String) = "plugins.connection.$id"
}

/** What a plugin page is doing now: at most one write at a time, and what the last one was refused for. */
@Stable
class PluginActs {
    /** The write under way, by what started it ([PluginActionTags]); null when none. */
    var pending by mutableStateOf<String?>(null)
        private set
    var refusal by mutableStateOf<PluginRefusal?>(null)

    /** Runs [act] unless another is under way; true when it worked. */
    suspend fun run(what: String, act: suspend () -> Unit): Boolean {
        if (pending != null) return false
        pending = what
        refusal = null
        return try {
            act()
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: PluginsException) {
            refusal = e.refusal
            false
        } catch (_: Exception) {
            refusal = PluginRefusal.Failed
            false
        } finally {
            pending = null
        }
    }
}

/** A refusal that isn't about one field, said in our words, or the server's own. */
@Composable
internal fun refusalWords(refusal: PluginRefusal): String = when (refusal) {
    PluginRefusal.Forbidden -> stringResource(R.string.problem_forbidden)
    PluginRefusal.NotFound -> stringResource(R.string.plugins_refused_gone)
    PluginRefusal.Unsupported -> stringResource(R.string.plugins_refused_unsupported)
    is PluginRefusal.Said -> refusal.message
    is PluginRefusal.Fields, PluginRefusal.Failed -> stringResource(R.string.plugins_refused_failed)
}

/** A refusal other than refused fields, as an alert until it is closed. */
@Composable
internal fun RefusalAlert(acts: PluginActs) {
    val refusal = acts.refusal?.takeIf { it !is PluginRefusal.Fields } ?: return
    HappyAlert(Alert(refusalWords(refusal), buttons = listOf(AlertButton(stringResource(android.R.string.ok)))), onDismiss = { acts.refusal = null })
}

/**
 * Under a plugin's picture, for someone who may manage plugins: Install,
 * full width; Install again once one is installed and the plugin may be
 * installed more than once; a Happy Agent host's reason where it can't.
 * Others read who may.
 */
@Composable
internal fun PluginInstallActions(plugin: Plugin, snapshot: PluginsSnapshot, acts: PluginActs, onInstall: () -> Unit) {
    val installed = snapshot.installationsOf(plugin.key).isNotEmpty()
    Column(
        Modifier.fillMaxWidth().padding(horizontal = PluginsSpec.heroPadding).padding(top = 16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        val refused = plugin.installability as? Installability.Refused
        when {
            !snapshot.canManage -> if (!installed) Note(stringResource(R.string.plugins_manage_note))
            refused != null -> Note(refused.reason ?: stringResource(R.string.plugins_not_installable))
            !installed || plugin.multiInstance -> RoundButton(
                title = stringResource(if (installed) R.string.plugins_install_again else R.string.plugins_install),
                onClick = onInstall,
                // Once installed, another installation is the rarer want: the quiet button.
                display = if (installed) RoundButtonDisplay.Inverted else RoundButtonDisplay.Default,
                loading = acts.pending == PluginActionTags.INSTALL,
                enabled = acts.pending == null,
                modifier = Modifier.fillMaxWidth().testTag(PluginActionTags.INSTALL),
            )
        }
    }
}

@Composable
private fun Note(text: String) {
    Text(text, style = happyTextStyle(fontSize = 14, lineHeight = 20), color = HappyTheme.colors.textSecondary, modifier = Modifier.fillMaxWidth())
}

/**
 * One installation's page: its state, then for someone who may manage it
 * Set up (each method the plugin offers: a browser sign-in opens in a
 * Custom Tab, fields are typed here and saved), Signed in (the accounts it
 * holds, each disconnected alone) and Remove. A plugin the server no longer
 * offers can only be read.
 */
@Composable
fun PluginInstallationScreen(
    state: PluginsState,
    installationId: String,
    connections: List<PluginConnection>,
    acts: PluginActs,
    /** The browser was sent to a sign-in: say where to finish it. */
    signingIn: Boolean,
    onConnect: (PluginInstallation, PluginAuthMethod.OAuth) -> Unit,
    onConfigure: (PluginInstallation, PluginAuthMethod.Fields, Map<String, String>) -> Unit,
    onDisconnect: (PluginInstallation, PluginConnection?) -> Unit,
    onRemove: (PluginInstallation) -> Unit,
    onBack: () -> Unit,
) {
    val snapshot = (state as? PluginsState.Loaded)?.snapshot
    val installation = snapshot?.installations?.firstOrNull { it.id == installationId }
    val plugin = installation?.let { snapshot.plugin(it.pluginKey) }
    var confirming by remember { mutableStateOf<Confirm?>(null) }
    Screen(header = { StackHeader(installation?.let(::installationTitle) ?: stringResource(R.string.plugins_title), onBack) }, avoidKeyboard = true) {
        ItemList(modifier = Modifier.testTag(PluginsTags.PAGE)) {
            if (installation == null) {
                ItemGroup {
                    if (state == PluginsState.Loading) Item(title = stringResource(R.string.plugins_loading), loading = true, showChevron = false)
                    else Item(title = stringResource(R.string.plugins_refused_gone), titleColor = HappyTheme.colors.textSecondary, showChevron = false)
                }
                return@ItemList
            }
            ItemGroup(footer = (installation.status as? InstallationStatus.Failed)?.error ?: if (!installation.available) stringResource(R.string.plugins_no_longer_offered) else null) {
                Item(
                    title = installationTitle(installation),
                    subtitle = statusWords(installation),
                    subtitleColor = statusColor(installation),
                    icon = { PluginMark(installation.image ?: plugin?.image, PluginsSpec.rowMark) },
                    showChevron = false,
                )
            }
            val manage = snapshot.canManage && installation.available
            if (manage && plugin != null && plugin.authMethods.isNotEmpty()) {
                ItemGroup(
                    title = stringResource(R.string.plugins_set_up),
                    footer = if (signingIn) stringResource(R.string.plugins_signed_in_browser) else null,
                ) {
                    val single = plugin.authMethods.size == 1
                    for (method in plugin.authMethods) {
                        when (method) {
                            is PluginAuthMethod.OAuth -> Item(
                                title = stringResource(R.string.plugins_continue_with, method.label),
                                onClick = { onConnect(installation, method) },
                                loading = acts.pending == PluginActionTags.method(method.id),
                                enabled = acts.pending == null,
                                modifier = Modifier.testTag(PluginActionTags.method(method.id)),
                            )
                            is PluginAuthMethod.Fields -> FieldsMethod(method, single, acts) { values -> onConfigure(installation, method, values) }
                        }
                    }
                }
            }
            if (manage && (connections.isNotEmpty() || (installation.status == InstallationStatus.Active && installation.authMethod != null))) {
                ItemGroup(title = stringResource(R.string.plugins_connected)) {
                    for (connection in connections) {
                        Item(
                            title = connection.name,
                            subtitle = connection.description.ifBlank { null },
                            detail = stringResource(R.string.plugins_disconnect),
                            detailColor = HappyTheme.colors.textDestructive,
                            showChevron = false,
                            enabled = acts.pending == null,
                            onClick = { confirming = Confirm.Disconnect(connection) },
                            modifier = Modifier.testTag(PluginActionTags.connection(connection.id)),
                        )
                    }
                    if (connections.isEmpty()) {
                        Item(
                            title = stringResource(R.string.plugins_disconnect),
                            destructive = true,
                            showChevron = false,
                            loading = acts.pending == PluginActionTags.DISCONNECT,
                            enabled = acts.pending == null,
                            onClick = { confirming = Confirm.Disconnect(null) },
                            modifier = Modifier.testTag(PluginActionTags.DISCONNECT),
                        )
                    }
                }
            }
            if (manage) {
                ItemGroup {
                    Item(
                        title = stringResource(R.string.plugins_remove),
                        destructive = true,
                        showChevron = false,
                        loading = acts.pending == PluginActionTags.REMOVE,
                        enabled = acts.pending == null,
                        onClick = { confirming = Confirm.Remove },
                        modifier = Modifier.testTag(PluginActionTags.REMOVE),
                    )
                }
            }
        }
    }
    if (installation != null) {
        when (val asked = confirming) {
            is Confirm.Disconnect -> HappyAlert(disconnectAlert(installation, asked.connection, onDisconnect), onDismiss = { confirming = null })
            Confirm.Remove -> HappyAlert(removeAlert(installation, onRemove), onDismiss = { confirming = null })
            null -> Unit
        }
    }
    RefusalAlert(acts)
}

/** What a destructive row asks before it runs. */
private sealed interface Confirm {
    data class Disconnect(val connection: PluginConnection?) : Confirm
    data object Remove : Confirm
}

@Composable
private fun disconnectAlert(installation: PluginInstallation, connection: PluginConnection?, onDisconnect: (PluginInstallation, PluginConnection?) -> Unit) = Alert(
    stringResource(R.string.plugins_disconnect_title, connection?.name ?: installationTitle(installation)),
    stringResource(R.string.plugins_disconnect_body),
    listOf(
        AlertButton(stringResource(R.string.common_cancel)),
        AlertButton(stringResource(R.string.plugins_disconnect), destructive = true) { onDisconnect(installation, connection) },
    ),
)

@Composable
private fun removeAlert(installation: PluginInstallation, onRemove: (PluginInstallation) -> Unit) = Alert(
    stringResource(R.string.plugins_remove_title, installationTitle(installation)),
    stringResource(R.string.plugins_remove_body),
    listOf(
        AlertButton(stringResource(R.string.common_cancel)),
        AlertButton(stringResource(R.string.plugins_remove), destructive = true) { onRemove(installation) },
    ),
)

/**
 * A fields method: its label, then (open when it is the plugin's only
 * method, else on a tap) each field with its help under it and the
 * server's word on it after a refusal, then Save. Secret fields are
 * masked and never kept past the screen; nothing typed is saved with it.
 */
@Composable
private fun FieldsMethod(method: PluginAuthMethod.Fields, open: Boolean, acts: PluginActs, onSave: (Map<String, String>) -> Unit) {
    var expanded by rememberSaveable(method.id) { mutableStateOf(open) }
    val values = remember(method.id) { mutableStateMapOf<String, String>() }
    if (!open) {
        Item(
            title = method.label,
            onClick = { expanded = !expanded },
            modifier = Modifier.testTag(PluginActionTags.method(method.id)),
        )
    }
    if (!expanded) return
    val refused = (acts.refusal as? PluginRefusal.Fields)?.fields.orEmpty()
    val colors = HappyTheme.colors
    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (field in method.fields) {
            Text(
                if (field.required) "${field.label} · ${stringResource(R.string.plugins_field_required)}" else field.label,
                style = happyTextStyle(fontSize = 13, lineHeight = 18),
                color = colors.textSecondary,
            )
            HappyTextField(
                value = values[field.key].orEmpty(),
                onValueChange = { values[field.key] = it },
                placeholder = field.label,
                textStyle = happyTextStyle(fontSize = 15, lineHeight = 20),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
                minHeight = 44.dp,
                cornerRadius = 8.dp,
                singleLine = !field.multiline,
                enabled = acts.pending == null,
                visualTransformation = if (field.secret) PasswordVisualTransformation() else VisualTransformation.None,
                keyboardOptions = KeyboardOptions(
                    keyboardType = if (field.secret) KeyboardType.Password else KeyboardType.Ascii,
                    imeAction = if (field.multiline) ImeAction.Default else ImeAction.Next,
                    autoCorrectEnabled = false,
                ),
                modifier = Modifier.testTag(PluginActionTags.field(field.key)),
            )
            refused[field.key]?.let { Text(it, style = happyTextStyle(fontSize = 13, lineHeight = 18), color = colors.textDestructive, modifier = Modifier.testTag(PluginActionTags.fieldError(field.key))) }
            if (field.help.isNotBlank()) Text(field.help, style = happyTextStyle(fontSize = 13, lineHeight = 18), color = colors.textSecondary)
        }
        val ready = method.fields.all { !it.required || values[it.key].orEmpty().isNotBlank() }
        RoundButton(
            title = stringResource(R.string.plugins_save),
            onClick = { onSave(method.fields.associate { it.key to values[it.key].orEmpty().trim() }.filterValues { it.isNotEmpty() }) },
            enabled = ready && acts.pending == null,
            loading = acts.pending == PluginActionTags.method(method.id),
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp).testTag(PluginActionTags.SAVE),
        )
    }
}
