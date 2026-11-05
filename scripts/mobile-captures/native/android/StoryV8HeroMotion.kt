package com.slopus.happy.fixture

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.*
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.agent.*
import com.slopus.happy.ui.connection.*
import com.slopus.happy.ui.home.*
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import kotlinx.serialization.json.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Runs with Android's normal Choreographer. There is no Compose test clock. */
@RunWith(AndroidJUnit4::class)
class StoryV8HeroMotion {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private fun asset(path: String) = instrumentation.context.assets.open("marketing/$path").use { it.readBytes() }
    private fun json(name: String) = Json.parseToJsonElement(asset("$name.json").toString(Charsets.UTF_8)).jsonObject
    private fun catalog(name: String) = AgentCatalog().withBootstrap(AgentClient.json.decodeFromString<WireDesktopBootstrap>(asset("$name.json").toString(Charsets.UTF_8)))
    @Test fun hero() {
        java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("UTC"))
        val dir = File(instrumentation.targetContext.filesDir,"v8-shots").apply { mkdirs() }
        val device = UiDevice.getInstance(instrumentation)
        val catalogs = (0..3).map { catalog("video$it") }
        val people = TeamUser.parse(json("users")["users"]?.jsonArray).associateBy { it.id }
        val initialGit = json("git")["snapshots"]!!.jsonObject.filterKeys { !it.startsWith("sub-") }.mapValues { (_,v) ->
            val o=v.jsonObject; WorkspaceLineChanges("ready",o["insertions"]!!.jsonPrimitive.long,o["deletions"]!!.jsonPrimitive.long,true,0.0)
        }
        val pictures = AgentPictures("fictional-v8-motion", fetch = { path -> asset(if(path.contains("/users/")) "photos/${if(path.contains("steve")) "steve" else "kirill"}.jpg" else "icons/feed-2-160.png") })
        val accounts = AccountMenu(listOf(AccountMenuEntry("team","Happy Engineering Team",agent=true,active=true,seed="agent:demo-team")))
        var phase by mutableIntStateOf(0)
        var git by mutableStateOf(initialGit)
        val activity = ActivityScenario.launch(ComponentActivity::class.java)
        try {
            activity.onActivity { a ->
                a.enableEdgeToEdge()
                a.setContent {
                    HappyTheme(preference=ThemePreference.Light) {
                        CompositionLocalProvider(LocalAgentPictures provides pictures) {
                            AgentHomeScreen("Happy Engineering Team", AgentFeed.derive(catalogs[phase],git=git,feedUnread=3,users=people), AgentLinkStatus.Connected, accounts, AgentHomeActions({}, {}, {}, {}, {}, {}, onVoice = {}))
                        }
                    }
                }
            }
            SystemClock.sleep(2500)
            File(dir,"hero-ready").writeText("${System.currentTimeMillis()}")
            SystemClock.sleep(3500)
            val began = SystemClock.elapsedRealtime()
            File(dir,"hero-timing.tsv").writeText("begin\t${System.currentTimeMillis()}\t$began\n")
            fun move(p: Int) { activity.onActivity { phase=p } }
            fun change(id: String,p: Long,m: Long) { activity.onActivity { git=git+(id to WorkspaceLineChanges("ready",p,m,true,0.0)) } }
            for((i,at) in listOf(2000L,3200L,4600L,6000L,7400L,8800L,11000L).withIndex()) {
                SystemClock.sleep((began+at-SystemClock.elapsedRealtime()).coerceAtLeast(0))
                when(i) {
                    0 -> move(1)
                    1 -> change("sub-icons",8,0)
                    2 -> {move(2);change("sub-icons",21,2)}
                    3 -> {change("sub-icons",34,3);change("sub-dots",6,0)}
                    4 -> change("sub-icons",47,5)
                    5 -> {change("sub-icons",52,9);change("sub-dots",14,1)}
                    6 -> move(3)
                }
                File(dir,"hero-timing.tsv").appendText("step$i\t${System.currentTimeMillis()}\t${SystemClock.elapsedRealtime()}\n")
            }
            SystemClock.sleep((began+18000-SystemClock.elapsedRealtime()).coerceAtLeast(0))
            device.takeScreenshot(File(dir,"01-hero-end.png"))
            File(dir,"hero-done").writeText("${System.currentTimeMillis()}")
        } finally {activity.close()}
    }
}