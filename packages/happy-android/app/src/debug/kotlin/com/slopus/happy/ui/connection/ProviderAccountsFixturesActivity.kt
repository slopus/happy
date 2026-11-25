package com.slopus.happy.ui.connection

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.navigation.compose.rememberNavController
import com.slopus.happy.R
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.AgentProviderSignIns
import com.slopus.happy.agent.ProviderAccounts
import com.slopus.happy.ui.RetainedNavHost
import com.slopus.happy.ui.backdrop
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.page
import com.slopus.happy.ui.rememberNavMotion
import com.slopus.happy.ui.settings.SettingsTile
import com.slopus.happy.ui.settings.SettingsTiles
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.Serializable

/**
 * Debug builds only: Settings › Inference (a Happy Agent's accounts) and its sign-in and token
 * pages, the real client over [ProviderSignInDaemon] (the contract in
 * memory; no vendor is reached). Start it with
 * `adb shell am start -n com.slopus.happy.dev/com.slopus.happy.ui.connection.ProviderAccountsFixturesActivity`
 * and `--es providerAccounts.scene normal|success|failure|owner|missing|states|legacy`;
 * `--es providerAccounts.account codex` opens that account,
 * `--es providerAccounts.signIn codex` its sign-in, and
 * `--es providerAccounts.token claude_work` its token page.
 */
class ProviderAccountsFixturesActivity : ComponentActivity() {
    @Serializable private data object FixtureSettingsRoute

    private val scope = CoroutineScope(SupervisorJob() + kotlinx.coroutines.Dispatchers.Main.immediate)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val daemon = ProviderSignInDaemon(intent.getStringExtra("providerAccounts.scene") ?: "normal", scope)
        val accounts = ProviderAccounts(AgentProviderSignIns(AgentClient(daemon, "fixture")), daemon.events, scope)
        val account = intent.getStringExtra("providerAccounts.account")
        val signIn = intent.getStringExtra("providerAccounts.signIn")
        val token = intent.getStringExtra("providerAccounts.token")
        setContent {
            HappyTheme {
                val nav = rememberNavController()
                RetainedNavHost(nav, FixtureSettingsRoute, rememberNavMotion(), modifier = Modifier.backdrop(nav)) {
                    page<FixtureSettingsRoute> {
                        AgentPage(stringResource(R.string.settings_title), onBack = ::finish) {
                            ItemGroup(title = stringResource(R.string.settings_group_agents)) {
                                Item(
                                    stringResource(R.string.provider_accounts_title),
                                    icon = { SettingsTile(Ionicon.KeyOutline, SettingsTiles.indigo) },
                                    onClick = { nav.navigate(ProviderAccountsRoute(FIXTURE)) },
                                    modifier = Modifier.testTag(ProviderAccountsTags.ROW),
                                )
                            }
                        }
                    }
                    providerAccountRoutes(nav) { remember { accounts } }
                }
                LaunchedEffect(Unit) {
                    if (savedInstanceState != null) return@LaunchedEffect
                    if (account != null || signIn != null || token != null) nav.navigate(ProviderAccountsRoute(FIXTURE))
                    account?.let { nav.navigate(ProviderAccountRoute(FIXTURE, it)) }
                    signIn?.let { nav.navigate(ProviderSignInRoute(FIXTURE, it)) }
                    token?.let { nav.navigate(ProviderTokenRoute(FIXTURE, it)) }
                }
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        scope.cancel()
    }

    private companion object {
        const val FIXTURE = "fixture"
    }
}
