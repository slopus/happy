package com.slopus.happy.ui.onboarding

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.res.stringResource
import com.slopus.happy.R
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.components.TitleAlignment
import com.slopus.happy.ui.theme.HappyTheme

/** onboarding/settings.tsx */
object OnboardingSettingsSpec {
    val icon = 28.dp
}

/**
 * The gear on Link Your Computer (onboarding/settings.tsx): point at a
 * different server, or throw the account away and start again. Logging out
 * is safe here: nothing is linked to the account yet.
 *
 * Spec: two untitled groups. "Server" with the custom host (or "Default")
 * as its detail, a 28 server icon in secondary and a chevron; then "Log out
 * and start over", destructive, 28 log-out icon in textDestructive, no
 * chevron, with the reassurance as the group's footer. Logout asks first.
 */
@Composable
fun OnboardingSettingsScreen(
    customServerLabel: String?,
    onServer: () -> Unit,
    onLogout: () -> Unit,
    onBack: () -> Unit,
) {
    val colors = HappyTheme.colors
    var alert by remember { mutableStateOf<Alert?>(null) }
    val confirmTitle = stringResource(R.string.onboarding_logout_confirm_title)
    val confirmBody = stringResource(R.string.onboarding_logout_confirm_body)
    val logout = stringResource(R.string.common_logout)
    val cancel = stringResource(R.string.common_cancel)

    Screen(header = { StackHeader(stringResource(R.string.onboarding_settings_title), onBack, TitleAlignment.Center) }) {
        ItemList {
            ItemGroup {
                Item(
                    title = stringResource(R.string.onboarding_settings_server),
                    detail = customServerLabel ?: stringResource(R.string.onboarding_settings_server_default),
                    icon = { Icon(Ionicon.ServerOutline, OnboardingSettingsSpec.icon, colors.textSecondary) },
                    onClick = onServer,
                )
            }
            ItemGroup(footer = stringResource(R.string.onboarding_logout_footer)) {
                Item(
                    title = stringResource(R.string.onboarding_logout_start_over),
                    icon = { Icon(Ionicon.LogOutOutline, OnboardingSettingsSpec.icon, colors.textDestructive) },
                    destructive = true,
                    showChevron = false,
                    onClick = {
                        alert = Alert(
                            confirmTitle,
                            confirmBody,
                            listOf(AlertButton(cancel), AlertButton(logout, destructive = true, onClick = onLogout)),
                        )
                    },
                )
            }
        }
    }
    alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
}
