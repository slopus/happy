package com.slopus.happy.ui.connect

import android.content.Intent
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.HappyShareLinks
import com.slopus.happy.agent.HappyShareRole
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/**
 * Verified App Links: production's overlay (src/release) claims
 * link.happy.page's one path, `/`, with autoVerify, and the share links the
 * app copies are exactly what that filter takes and what [parseDeepLink]
 * opens. Debug and preview claim no share links; the host's assetlinks.json
 * names com.ex3ndr.happy alone.
 */
@RunWith(AndroidJUnit4::class)
class AppLinksManifestTest {
    private val instance = "k3x9q2m7p0a4b8c1d5e6f7g2"

    private data class Filter(val autoVerify: Boolean, val actions: Set<String>, val categories: Set<String>, val data: List<Map<String, String>>)

    private fun filters(manifest: String): List<Filter> {
        val document = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
            .newDocumentBuilder().parse(File(manifest))
        val nodes = document.getElementsByTagName("intent-filter")
        fun Element.children(tag: String) = (0 until getElementsByTagName(tag).length).map { getElementsByTagName(tag).item(it) as Element }
        fun Element.android(name: String) = getAttributeNS(ANDROID, name)
        return (0 until nodes.length).map { nodes.item(it) as Element }.map { filter ->
            Filter(
                autoVerify = filter.android("autoVerify") == "true",
                actions = filter.children("action").map { it.android("name") }.toSet(),
                categories = filter.children("category").map { it.android("name") }.toSet(),
                data = filter.children("data").map { data ->
                    listOf("scheme", "host", "path", "pathPrefix", "pathPattern").mapNotNull { name -> data.android(name).takeIf { it.isNotEmpty() }?.let { name to it } }.toMap()
                },
            )
        }
    }

    private fun shareFilters(manifest: String) = filters(manifest).filter { filter -> filter.data.any { it["host"] == "link.happy.page" } }

    @After
    fun tearDown() {
        DeepLinks.pending.value?.let(DeepLinks::consume)
    }

    @Test
    fun productionClaimsTheSharePageAndVerifiesIt() {
        val filter = shareFilters("src/release/AndroidManifest.xml").single()
        assertTrue(filter.autoVerify)
        assertEquals(setOf(Intent.ACTION_VIEW), filter.actions)
        assertEquals(setOf(Intent.CATEGORY_BROWSABLE, Intent.CATEGORY_DEFAULT), filter.categories)
        // https alone: an http scheme in the same filter would fail verification for the whole filter.
        assertEquals(listOf(mapOf("scheme" to "https", "host" to "link.happy.page", "path" to "/")), filter.data)
    }

    @Test
    fun otherBuildsLeaveShareLinksToTheBrowser() {
        for (manifest in listOf("src/main/AndroidManifest.xml", "src/bench/AndroidManifest.xml")) {
            assertEquals(manifest, emptyList<Filter>(), shareFilters(manifest))
        }
    }

    /**
     * A Happy Cloud invite link opens the app in every build: its filter is
     * in the main manifest, on MainActivity itself, verified, and takes the
     * web host's `/join` alone (`/` is the server picker). No alias holds
     * it and nothing enables or disables one, so Settings' Happy Cloud
     * switch, which only hides Cloud's ways in, has no say in it.
     */
    @Test
    fun everyBuildClaimsCloudInviteLinksWhateverTheSwitchSays() {
        val manifest = File("src/main/AndroidManifest.xml")
        val document = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }.newDocumentBuilder().parse(manifest)
        fun elements(tag: String) = document.getElementsByTagName(tag).let { nodes -> (0 until nodes.length).map { nodes.item(it) as Element } }
        val main = elements("activity").single { it.getAttributeNS(ANDROID, "name") == ".MainActivity" }
        // Never switched off in the manifest, and the launcher's alias is the only alias there is.
        assertEquals("", main.getAttributeNS(ANDROID, "enabled"))
        assertEquals(listOf("com.ex3ndr.happy.MainActivity"), elements("activity-alias").map { it.getAttributeNS(ANDROID, "name") })

        val mainFilters = main.getElementsByTagName("intent-filter").let { nodes -> (0 until nodes.length).map { nodes.item(it) as Element } }
        fun Element.data() = getElementsByTagName("data").let { nodes -> (0 until nodes.length).map { nodes.item(it) as Element } }
            .map { data -> listOf("scheme", "host", "path", "pathPrefix", "pathPattern").mapNotNull { name -> data.getAttributeNS(ANDROID, name).takeIf { it.isNotEmpty() }?.let { name to it } }.toMap() }
        val invite = mainFilters.single { filter -> filter.data().any { it["host"] == "\${happyCloudWebHost}" } }
        assertEquals("true", invite.getAttributeNS(ANDROID, "autoVerify"))
        assertEquals(listOf(mapOf("scheme" to "https", "host" to "\${happyCloudWebHost}", "path" to "/join")), invite.data())
        val all = filters(manifest.path)
        val claimed = all.single { filter -> filter.data.any { it["host"] == "\${happyCloudWebHost}" } }
        assertEquals(setOf(Intent.ACTION_VIEW), claimed.actions)
        assertEquals(setOf(Intent.CATEGORY_BROWSABLE, Intent.CATEGORY_DEFAULT), claimed.categories)
        // The web join page's "Open in Happy" comes in by the app's own scheme, also on MainActivity.
        assertTrue(mainFilters.any { filter -> filter.data() == listOf(mapOf("scheme" to "happy")) })

        // There is no invite host of its own any more: no manifest and no build setting names one, and nothing toggles a component.
        for (source in listOf("src/main/AndroidManifest.xml", "src/debug/AndroidManifest.xml", "src/release/AndroidManifest.xml", "src/bench/AndroidManifest.xml", "build.gradle.kts")) {
            val text = File(source).readText()
            assertTrue(source, "happyCloudInviteHost" !in text && "HAPPY_CLOUD_INVITE" !in text && "happy.cloudInvite" !in text)
        }
        val setting = File("src/main/kotlin/com/slopus/happy/config/HappyCloudSetting.kt").readText()
        assertTrue("setComponentEnabledSetting" !in setting && "PackageManager" !in setting)
    }

    /** Both forms of an invite link, as the system hands them over, reach the invite; the built manifest takes the web one at the default host. */
    @Test
    fun bothInviteLinkFormsResolveToTheAppAndOpenTheInvite() {
        val token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde"
        val context = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
        for (link in listOf("https://happybases.com/join#$token", "happy://cloud/join#$token")) {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link)).addCategory(Intent.CATEGORY_BROWSABLE).setPackage(context.packageName)
            val handlers = context.packageManager.queryIntentActivities(intent, 0).map { it.activityInfo.name }
            assertEquals(link.replace(token, "…"), listOf("com.slopus.happy.MainActivity"), handlers)
            assertTrue(DeepLinks.offer(intent))
            assertEquals(DeepLink.CloudServerInvite(com.slopus.happy.connection.CloudInvite(token)), DeepLinks.pending.value)
        }
        // The host's other paths are the web's.
        for (link in listOf("https://happybases.com/", "https://happybases.com/#$token", "https://acme.happybases.com/join#$token")) {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link)).addCategory(Intent.CATEGORY_BROWSABLE).setPackage(context.packageName)
            assertEquals(link.replace(token, "…"), emptyList<String>(), context.packageManager.queryIntentActivities(intent, 0).map { it.activityInfo.name })
        }
    }

    @Test
    fun whatTheAppCopiesIsWhatTheFilterTakesAndOpens() {
        for ((link, role) in listOf(
            "happy://$instance/agents/t1" to HappyShareRole.Task,
            "happy://$instance/artifacts/r1?version=2" to null,
            "happy://$instance/agents/t1/files/src/main.ts#L42-L50" to null,
        )) {
            val share = HappyShareLinks.format(link, role)!!
            val uri = Uri.parse(share)
            assertEquals(share, "https", uri.scheme)
            assertEquals(share, "link.happy.page", uri.host)
            assertEquals(share, "/", uri.path)
            assertTrue(share, parseDeepLink(share) is DeepLink.Instance)
            assertTrue(share, DeepLinks.offer(Intent(Intent.ACTION_VIEW, uri)))
            assertEquals(share, parseDeepLink(share), DeepLinks.pending.value)
        }
    }

    private companion object {
        const val ANDROID = "http://schemas.android.com/apk/res/android"
    }
}
