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
