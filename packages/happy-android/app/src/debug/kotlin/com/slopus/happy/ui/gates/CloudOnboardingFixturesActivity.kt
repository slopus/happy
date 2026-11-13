package com.slopus.happy.ui.gates

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.slopus.happy.onboarding.CloudOnboarding
import com.slopus.happy.onboarding.OnboardingGate
import com.slopus.happy.onboarding.OnboardingGate.Kind
import com.slopus.happy.onboarding.OnboardingGate.Requirement
import com.slopus.happy.onboarding.OnboardingGate.Scope
import com.slopus.happy.onboarding.OnboardingGate.Status
import com.slopus.happy.onboarding.OnboardingPlan
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.delay

/**
 * Debug builds only: a Happy Cloud server's onboarding flow over an
 * in-memory server, walked by the real plan. `--es gates <set>`:
 * `walk` (profile, photo, the admin bot, a payment method; the default),
 * `waiting` (a payment only an owner adds), `unavailable`, `update` (a gate
 * this app doesn't know), `finish`, `bot` (the admin bot, inference,
 * plugins), `team` (teammates, notifications, a payment method; with
 * `--es invites ok|nomail|none` and `--es push ok|denied|unsupported`).
 * Start it with
 * `adb shell am start -n com.slopus.happy.dev/com.slopus.happy.ui.gates.CloudOnboardingFixturesActivity`.
 */
class CloudOnboardingFixturesActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val set = intent.getStringExtra("gates") ?: "walk"
        val invites = intent.getStringExtra("invites") ?: "ok"
        val push = intent.getStringExtra("push") ?: "ok"
        setContent {
            HappyTheme {
                var onboarding by remember { mutableStateOf(start(set)) }
                var held by remember { mutableStateOf<OnboardingGate?>(null) }
                fun change(id: String, status: Status) {
                    val gates = onboarding.gates.map { if (it.id == id) it.copy(status = status, blocking = false) else it }
                    onboarding = onboarding.copy(gates = gates, finished = gates.none { it.pending })
                }
                val plan = OnboardingPlan.of(onboarding)
                val step = held?.let { OnboardingPlan.Step.Gate(it) } ?: plan.step(showing = true) ?: return@HappyTheme
                CloudOnboardingFlow(
                    onboarding = onboarding,
                    step = step,
                    progress = if (plan.count > 1) plan.progress else null,
                    handle = "@acme",
                    seed = "acme",
                    name = "Olga Petrova",
                    photo = null,
                    meets = true,
                    actions = OnboardingActions(
                        skip = { id -> delay(500); change(id, Status.Skipped) },
                        check = { delay(700); throw IllegalStateException("offline") },
                        saveName = { delay(600); change("profile", Status.Done) },
                        savePhoto = { delay(900); change("avatar", Status.Done) },
                        finish = { delay(700); finish() },
                        web = "https://acme.happy.engineering/",
                        onNotNow = if (onboarding.gates.any { it.blocking }) null else ({ finish() }),
                        renameBot = { _, _ -> delay(600); change("adminBot", Status.Done) },
                        inference = InferenceHost(
                            offer = { delay(400); com.slopus.happy.agent.CloudCapabilities(apiKeys = true, claudeSetupToken = true, codexSignIn = true) },
                            custom = true,
                            allowed = true,
                            open = { change("inference", Status.Done) },
                        ),
                        plugins = PluginsHost(plugins, open = { key -> connect(key) }, refresh = {}),
                        teammates = TeammatesHost(
                            invite = { email ->
                                delay(600)
                                when {
                                    invites == "none" -> throw com.slopus.happy.onboarding.TeamInviteRefusal.Unsupported
                                    invites == "nomail" && email != null -> throw com.slopus.happy.onboarding.TeamInviteRefusal.EmailNotConfigured
                                }
                                com.slopus.happy.onboarding.TeamInvite("inv-${email.hashCode()}", "https://acme.happy.engineering/join/7Hk2", if (email == null) null else if ("bounce" in email) "failed" else "sent")
                                    .also { change("teammates", Status.Done) }
                            },
                            share = {},
                            hold = { keep -> held = if (keep) onboarding.gates.first { it.id == "teammates" } else null },
                        ),
                        notifications = NotificationsHost(
                            turnOn = {
                                delay(600)
                                when (push) {
                                    "denied" -> PushOutcome.Denied
                                    "unsupported" -> PushOutcome.Unsupported
                                    else -> PushOutcome.Registered.also { change("mobileApp", Status.Done) }
                                }
                            },
                            openSettings = {},
                            store = {},
                        ),
                    ),
                )
            }
        }
    }

    private val plugins = kotlinx.coroutines.flow.MutableStateFlow<com.slopus.happy.plugins.PluginsState>(com.slopus.happy.plugins.PluginsState.Loaded(snapshot(emptySet())))

    private fun snapshot(active: Set<String>) = com.slopus.happy.plugins.PluginsSnapshot(
        listOf("github" to "GitHub", "linear" to "Linear", "weather" to "Weather").map { (id, name) ->
            com.slopus.happy.plugins.Plugin(id, id, name, "", "1.0", null, emptyList(), authRequired = id != "weather", authMethods = emptyList(),
                installability = com.slopus.happy.plugins.Installability.Installable, multiInstance = false)
        },
        active.map { com.slopus.happy.plugins.PluginInstallation("i-$it", it, it, 1, null, com.slopus.happy.plugins.InstallationStatus.Active, null, null, true) },
        canManage = true,
    )

    private fun connect(key: String) {
        val now = (plugins.value as? com.slopus.happy.plugins.PluginsState.Loaded)?.snapshot?.installations?.map { it.pluginKey }?.toSet().orEmpty()
        plugins.value = com.slopus.happy.plugins.PluginsState.Loaded(snapshot(now + key))
    }

    private fun start(set: String): CloudOnboarding {
        val bot = Kind.AdminBot("b1", "a1", "Chief of Staff", "v1", "Name your admin bot", emptyList(), null, null)
        return when (set) {
            "waiting" -> CloudOnboarding(false, gates = listOf(
                OnboardingGate("profile", Scope.Member, Requirement.Required, Status.Done, kind = Kind.Profile),
                OnboardingGate("paymentMethod", Scope.Server, Requirement.Required, Status.Open, canComplete = false, kind = Kind.PaymentMethod),
            ))
            "unavailable" -> CloudOnboarding(false, gates = listOf(
                OnboardingGate("payment", Scope.Server, Requirement.Required, Status.Unavailable, canComplete = true, kind = Kind.Payment),
            ))
            "update" -> CloudOnboarding(false, gates = listOf(
                OnboardingGate("sso", Scope.Member, Requirement.Required, Status.Open, canComplete = true, kind = Kind.Unknown),
            ))
            "bot" -> CloudOnboarding(false, gates = listOf(
                OnboardingGate("profile", Scope.Member, Requirement.Required, Status.Done, kind = Kind.Profile),
                OnboardingGate("adminBot", Scope.Server, Requirement.Optional, Status.Open, kind = bot.copy(
                    description = "This is your server's admin bot. It has expanded capabilities: it can change the server's settings, connect tools and create other bots, so it can adapt Happy and build a system around how your team works. Only owners can talk to it.",
                )),
                OnboardingGate("inference", Scope.Server, Requirement.Optional, Status.Open, kind = Kind.Inference(emptyList(), freeModel = true)),
                OnboardingGate("plugins", Scope.Server, Requirement.Required, Status.Open, kind = Kind.Plugins(listOf("github"), listOf(Kind.Plugins.Plugin("github", "GitHub", required = true, active = false)))),
            ))
            "team" -> CloudOnboarding(false, gates = listOf(
                OnboardingGate("profile", Scope.Member, Requirement.Required, Status.Done, kind = Kind.Profile),
                OnboardingGate("teammates", Scope.Server, Requirement.Optional, Status.Open, kind = Kind.Teammates(invited = false, members = 1)),
                OnboardingGate("mobileApp", Scope.Member, Requirement.Optional, Status.Open, kind = Kind.MobileApp(false, null, null)),
                OnboardingGate("paymentMethod", Scope.Server, Requirement.Optional, Status.Open, kind = Kind.PaymentMethod),
            ))
            "finish" -> CloudOnboarding(true, gates = listOf(OnboardingGate("adminBot", Scope.Server, Requirement.Optional, Status.Done, kind = bot)))
            else -> CloudOnboarding(false, gates = listOf(
                OnboardingGate("profile", Scope.Member, Requirement.Required, Status.Open, kind = Kind.Profile),
                OnboardingGate("avatar", Scope.Member, Requirement.Optional, Status.Open, kind = Kind.Avatar),
                OnboardingGate("adminBot", Scope.Server, Requirement.Optional, Status.Open, kind = bot),
                OnboardingGate("paymentMethod", Scope.Server, Requirement.Required, Status.Open, kind = Kind.PaymentMethod),
            ))
        }
    }
}
