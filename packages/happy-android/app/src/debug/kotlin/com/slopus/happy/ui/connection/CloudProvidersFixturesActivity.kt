package com.slopus.happy.ui.connection

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.navigation.compose.rememberNavController
import com.slopus.happy.agent.CloudCapabilities
import com.slopus.happy.agent.CloudConnection
import com.slopus.happy.agent.CloudDestination
import com.slopus.happy.agent.CloudProviders
import com.slopus.happy.agent.CloudProvidersSource
import com.slopus.happy.ui.RetainedNavHost
import com.slopus.happy.ui.backdrop
import com.slopus.happy.ui.page
import com.slopus.happy.ui.rememberNavMotion
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/**
 * Debug builds only: the AI providers list, its add chooser (every choice
 * offered, the team's own endpoint among them), the API key page with Grok,
 * and the own-endpoint form over an in-memory server: the ID `acme` is
 * taken, anything else is added. Start it with
 * `adb shell am start -n com.slopus.happy.dev/com.slopus.happy.ui.connection.CloudProvidersFixturesActivity`.
 */
class CloudProvidersFixturesActivity : ComponentActivity() {
    @Serializable private data object FixtureListRoute
    @Serializable private data object FixtureKeyRoute
    @Serializable private data object FixtureCustomRoute

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val connections = listOf(
            CloudConnection("operator:openai", "Happy (free)", "team", "operator", listOf("openai"), listOf("m"), 0, emptyList(), true),
            CloudConnection("grok", "Grok", "team", "tenant", listOf("grok"), listOf("m"), 1, emptyList(), true),
            CloudConnection("acme", "Acme vLLM", "team", "tenant", listOf("openai_compatible"), listOf("m"), 1, emptyList(), true),
        )
        setContent {
            HappyTheme {
                val nav = rememberNavController()
                RetainedNavHost(nav, FixtureListRoute, rememberNavMotion(), modifier = Modifier.backdrop(nav)) {
                    page<FixtureListRoute> {
                        var choosing by rememberSaveable { mutableStateOf(false) }
                        CloudProvidersScreen(CloudProvidersSource.State.Loaded(connections), canAdd = true, onAdd = { choosing = true }, onRetry = {}, onBack = ::finish)
                        if (choosing) {
                            CloudAddChooser(
                                CloudCapabilities(apiKeys = true, claudeSetupToken = true, codexSignIn = true),
                                custom = true,
                                onPick = { flow ->
                                    choosing = false
                                    when (flow) {
                                        is CloudProviderFlow.ApiKey -> nav.navigate(FixtureKeyRoute)
                                        CloudProviderFlow.Custom -> nav.navigate(FixtureCustomRoute)
                                        else -> Unit
                                    }
                                },
                                onDismiss = { choosing = false },
                            )
                        }
                    }
                    page<FixtureKeyRoute> {
                        var vendor by rememberSaveable { mutableStateOf(CloudProviders.GROK) }
                        CloudSecretScreen(
                            title = getString(com.slopus.happy.R.string.cloud_providers_add_key), field = getString(com.slopus.happy.R.string.cloud_providers_key), hint = null,
                            done = getString(com.slopus.happy.R.string.cloud_providers_key_done),
                            allowed = listOf(CloudDestination.Private, CloudDestination.Team), destination = CloudDestination.Team, onDestination = {},
                            vendors = listOf(CloudProviders.OPENAI, CloudProviders.ANTHROPIC, CloudProviders.GROK), vendor = vendor, onVendor = { vendor = it },
                            phase = SecretPhase.Editing, onSubmit = {}, onRetry = {}, onBack = { nav.popBackStack() },
                        )
                    }
                    page<FixtureCustomRoute> {
                        val scope = rememberCoroutineScope()
                        var phase by remember { mutableStateOf<SecretPhase>(SecretPhase.Editing) }
                        CloudCustomScreen(
                            phase = phase,
                            onSubmit = { draft ->
                                phase = SecretPhase.Checking
                                scope.launch {
                                    delay(900)
                                    phase = if (draft.id == "acme") SecretPhase.Failed(getString(com.slopus.happy.R.string.cloud_custom_exists)) else SecretPhase.Done
                                }
                            },
                            onRetry = { phase = SecretPhase.Editing },
                            onBack = { nav.popBackStack() },
                        )
                    }
                }
            }
        }
    }
}
