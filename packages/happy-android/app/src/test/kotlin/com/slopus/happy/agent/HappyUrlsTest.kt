package com.slopus.happy.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** happy-agent-client's tests/happyLinks.test.ts, case for case, and the external form (edge SSO contract §7). */
class HappyUrlsTest {
    private val id = "rg799k2m9q4w1e5t8y3u6i0o"
    private val agent = "a1b2c3d4"
    private val workspace = "k2h4j5l6"
    private val instance = "k3x9q2m7p0a4b8c1d5e6f7g2"

    private fun parse(url: String) = HappyUrls.parse(url)?.also { assertNull(it.instanceId) }?.link
    private fun file(url: String) = parse(url) as? HappyLink.File
    private fun agentFile(path: String, lines: IntRange? = null) = HappyLink.File(HappyLink.Target.Agent(agent), path, lines)

    @Test
    fun entityUrlsParseAndFormat() {
        for (kind in HappyReferenceKind.entries - HappyReferenceKind.Service) {
            val url = "happy://${kind.host}/$id"
            assertEquals(HappyLink.Reference(kind, id), parse(url))
            assertEquals(url, HappyUrls.format(HappyLink.Reference(kind, id)))
        }
        val links = listOf(
            HappyLink.Reference(HappyReferenceKind.Artifact, id, version = 12) to "happy://artifacts/$id?version=12",
            HappyLink.Reference(HappyReferenceKind.Service, "web", workspaceId = workspace) to "happy://workspaces/$workspace/services/web",
        )
        for ((reference, url) in links) {
            assertEquals(url, HappyUrls.format(reference))
            assertEquals(reference, parse(url))
        }
    }

    @Test
    fun malformedEntityUrlsAreRejected() {
        for (url in listOf(
            "happy://session/abc",
            "happy://terminal?MDEyMzQ1Njc4OWFiY2RlZg",
            "happy://artifact/$id",
            "happy://things/$id",
            "HAPPY://artifacts/$id",
            "happy://Artifacts/$id",
            "happy://artifacts/",
            "happy://artifacts/$id/",
            "happy://artifacts/a.b",
            "happy://artifacts/${"a".repeat(129)}",
            "happy://agents/$id?version=2",
            "happy://artifacts/$id?version=0",
            "happy://artifacts/$id?version=02",
            "happy://artifacts/$id?v=2",
            "happy://artifacts/$id?version=2&x=1",
            "happy://artifacts/$id#top",
            "happy://services/$id",
            "happy://agents/$agent/services/web",
            "happy://projects/$id/settings",
            "happy:artifacts/$id",
            " happy://artifacts/$id",
            // Java's `$` would match before a final line break; the grammar never does.
            "happy://artifacts/$id\n",
        )) assertNull(url, HappyUrls.parse(url))
    }

    @Test
    fun badReferencesAreNotFormatted() {
        for (reference in listOf(
            HappyLink.Reference(HappyReferenceKind.Artifact, "a\"b"),
            HappyLink.Reference(HappyReferenceKind.Agent, "a", version = 2),
            HappyLink.Reference(HappyReferenceKind.Artifact, "a", workspaceId = "w"),
            HappyLink.Reference(HappyReferenceKind.Service, "s"),
        )) assertThrows(IllegalArgumentException::class.java) { HappyUrls.format(reference) }
    }

    @Test
    fun fileUrlsParseBothTargetsWithAndWithoutLines() {
        assertEquals(agentFile("packages/app/Foo.tsx", 42..50), parse("happy://agents/$agent/files/packages/app/Foo.tsx#L42-L50"))
        assertEquals(HappyLink.File(HappyLink.Target.Workspace(workspace), "README.md"), parse("happy://workspaces/$workspace/files/README.md"))
        assertEquals("files/a.ts", file("happy://agents/$agent/files/files/a.ts")?.path)
        assertEquals(7..7, file("happy://agents/$agent/files/a.ts#L7")?.lines)
        assertEquals(7..7, file("happy://agents/$agent/files/a.ts#L7-L7")?.lines)
    }

    @Test
    fun segmentsDecodeAsUtf8InEitherHexCase() {
        assertEquals("docs/Résumé (1).md", file("happy://agents/$agent/files/docs/R%C3%A9sum%c3%a9%20%281%29.md")?.path)
        assertEquals("a:b@c!$&'*+,;=~.ts", file("happy://agents/$agent/files/a:b@c!$&'*+,;=~.ts")?.path)
        assertEquals("...ts", file("happy://agents/$agent/files/%2E%2E.ts")?.path)
        assertEquals(".env", file("happy://agents/$agent/files/.env")?.path)
    }

    @Test
    fun malformedFileUrlsAreRejected() {
        assertNull(HappyUrls.parse("happy://projects/$agent/files/a.ts"))
        for (suffix in listOf(
            "a.ts", "files", "files/", "files//a.ts", "files/src/", "files/src//a.ts", "files/./a.ts",
            "files/src/../a.ts", "files/%2e%2E/a.ts", "files/src%2Fa.ts", "files/src%5Ca.ts", "files/a%0A.ts",
            "files/a%C2%85.ts", "files/a%00.ts", "files/100%.ts", "files/a%4.ts", "files/a%C3.ts", "files/a%ED%A0%80.ts",
            "files/a b.ts", "files/a(1).ts", "files/é.ts", "files/a\\b.ts", "files/a.ts?raw=1", "files/a.ts#",
            "files/a.ts#l4", "files/a.ts#L0", "files/a.ts#L04", "files/a.ts#L1000000000", "files/a.ts#L9-L4",
            "files/a.ts#L4-9", "files/a.ts#L4C2", "files/a.ts#readme", "files/a.ts#L1#L2", "files/a%+1.ts",
        )) {
            val url = "happy://agents/$agent/$suffix"
            assertNull(url, HappyUrls.parse(url))
        }
    }

    @Test
    fun theWholeUrlIsBounded() {
        val prefix = "happy://agents/$agent/files/"
        val longest = prefix + "a".repeat(HappyUrls.MAX_LENGTH - prefix.length)
        assertEquals(longest.length - prefix.length, file(longest)?.path?.length)
        assertNull(HappyUrls.parse(longest + "a"))
    }

    @Test
    fun fileUrlsFormatCanonicallyAndParseBack() {
        val links = listOf(
            agentFile("packages/app/Foo.tsx", 42..50) to "happy://agents/$agent/files/packages/app/Foo.tsx#L42-L50",
            HappyLink.File(HappyLink.Target.Workspace(workspace), "README.md", 3..3) to "happy://workspaces/$workspace/files/README.md#L3",
            agentFile("docs/Résumé (1) [old]:#?%.md") to "happy://agents/$agent/files/docs/R%C3%A9sum%C3%A9%20%281%29%20%5Bold%5D%3A%23%3F%25.md",
            agentFile("it's*!~_-.ts") to "happy://agents/$agent/files/it%27s%2A%21~_-.ts",
        )
        for ((link, url) in links) {
            assertEquals(url, HappyUrls.format(link))
            assertEquals(link, parse(url))
        }
    }

    @Test
    fun badFilesAreNotFormatted() {
        for (link in listOf(
            agentFile("/etc/hosts"), agentFile(""), agentFile("a/../b"), agentFile("./b"), agentFile("a\\b"), agentFile("a\nb"),
            agentFile("a\ud800"), HappyLink.File(HappyLink.Target.Agent("a/b"), "a"), agentFile("a", 2..1), agentFile("a", 0..1),
            agentFile("é".repeat(1000)),
        )) assertThrows(IllegalArgumentException::class.java) { HappyUrls.format(link) }
    }

    @Test
    fun happyFileUrlsReadOntoTheSameModel() {
        assertEquals(parse("happy://agents/$agent/files/packages/app/Foo.tsx#L42-L50"), parse("happy-file://agents/$agent/packages/app/Foo.tsx#L42-L50"))
        assertEquals("docs/Résumé.md", file("happy-file://workspaces/$workspace/docs/R%C3%A9sum%C3%A9.md")?.path)
        val link = agentFile("docs/Résumé (1).md", 4..9)
        val url = "happy-file://agents/$agent/docs/R%C3%A9sum%C3%A9%20%281%29.md#L4-L9"
        assertEquals(url, HappyUrls.formatHappyFile(link))
        assertEquals(link, parse(url))
        val prefix = "happy-file://agents/$agent/"
        val longest = agentFile("a".repeat(HappyUrls.MAX_LENGTH - prefix.length))
        assertEquals(HappyUrls.MAX_LENGTH, HappyUrls.formatHappyFile(longest).length)
        assertThrows(IllegalArgumentException::class.java) { HappyUrls.formatHappyFile(longest.copy(path = longest.path + "a")) }
        for (bad in listOf(
            "HAPPY-FILE://agents/$agent/a.ts", "happy-file://agent/$agent/a.ts", "happy-file://projects/$agent/a.ts",
            "happy-file://agents/$agent", "happy-file://agents/$agent/src/", "happy-file://agents/$agent/src/../a.ts",
            "happy-file://agents/$agent/src%2Fa.ts", "happy-file://agents/$agent/a.ts?raw=1", "happy-file://agents/$agent/a.ts#readme",
            "happy-file://artifacts/$id",
        )) assertNull(bad, HappyUrls.parse(bad))
    }

    @Test
    fun externalLinksAreLockedToOneInstance() {
        val cases = listOf(
            "happy://$instance/artifacts/abc123?version=2" to HappyLink.Reference(HappyReferenceKind.Artifact, "abc123", version = 2),
            "happy://$instance/agents/a1/files/src/Foo.tsx#L42-L50" to HappyLink.File(HappyLink.Target.Agent("a1"), "src/Foo.tsx", 42..50),
            "happy://$instance/workspaces/w1/services/s1" to HappyLink.Reference(HappyReferenceKind.Service, "s1", workspaceId = "w1"),
        )
        for ((url, link) in cases) {
            assertEquals(HappyUrl(link, instance), HappyUrls.parse(url))
            assertEquals(url, HappyUrls.format(link, instance))
        }
        assertTrue(HappyUrls.isInstanceId(instance))
    }

    @Test
    fun malformedExternalLinksAreNeverPartlyRead() {
        for (url in listOf(
            "happy://$instance/",
            "happy://$instance",
            "happy://$instance/session/abc",
            "happy://$instance/artifacts/",
            "happy://$instance/happy-file://agents/a1/a.ts",
            "happy://$instance/$instance/artifacts/abc",
            "happy://${instance.uppercase()}/artifacts/abc",
            "happy://${instance.dropLast(1)}/artifacts/abc",
            "happy://${instance}x/artifacts/abc",
            "happy://1${instance.drop(1)}/artifacts/abc",
            "happy://$instance/artifacts/abc\n",
        )) assertNull(url, HappyUrls.parse(url))
        // An instance id that isn't one, and happy-file's form, have no external link.
        assertThrows(IllegalArgumentException::class.java) { HappyUrls.format(HappyLink.Reference(HappyReferenceKind.Artifact, "a"), "Not-An-Id") }
    }

    @Test
    fun theGrammarsHostsAreKnownWellFormedOrNot() {
        for (url in listOf("happy://artifacts/", "happy://Agents/x/y", "happy://$instance/whatever", "happy-file://x", "happy://surfaces")) assertTrue(url, HappyUrls.owns(url))
        for (url in listOf("happy://session/abc", "happy://terminal?k", "happy://direct?x", "happy://oauth/callback", "happy:///account?k", "https://happy.engineering")) assertFalse(url, HappyUrls.owns(url))
    }

    @Test
    fun settingsUrlsParseAndFormat() {
        for (page in HappyUrls.SETTINGS_PAGES) {
            val url = "happy://settings/$page"
            assertEquals(HappyLink.Settings(page), parse(url))
            assertEquals(url, HappyUrls.format(HappyLink.Settings(page)))
            assertTrue(url, HappyUrls.owns(url))
        }
        for (url in listOf(
            "happy://settings",
            "happy://settings/",
            "happy://settings/providers/",
            "happy://settings/Providers",
            "happy://settings/billing",
            "happy://settings/providers/export",
            "happy://settings/import",
            "happy://settings/providers?tab=keys",
            "happy://settings/providers#keys",
            "happy-file://settings/providers",
        )) {
            assertNull(url, HappyUrls.parse(url))
            assertTrue(url, HappyUrls.owns(url))
        }
        assertThrows(IllegalArgumentException::class.java) { HappyUrls.format(HappyLink.Settings("billing")) }
    }

    @Test
    fun settingsUrlsHaveAnInstanceForm() {
        val url = "happy://$instance/settings/mobile-access"
        assertEquals(HappyUrl(HappyLink.Settings("mobile-access"), instance), HappyUrls.parse(url))
        assertEquals(url, HappyUrls.format(HappyLink.Settings("mobile-access"), instance))
        assertNull(HappyUrls.parse("happy://$instance/settings/nowhere"))
    }
}
