package com.slopus.happy.agent

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Surfaces as the wire describes them, and the catalog of every one on the computer. */
class SurfacesTest {
    @Test
    fun aSingleUserAgentUsesNullForItsPersonsMembership() {
        val wire = Wire.surface("s1", "Plan", "document", mapOf("u1" to "1"))
        val original = AgentCatalog(surfaces = mapOf("s1" to wire), userId = null)
        val joined = original.withJoinedSurface("s1")
        assertTrue(Surface.parse(joined.surfaces.getValue("s1"))!!.joinedBy(null))
        val left = joined.withoutSurface("s1")
        assertFalse(Surface.parse(left.surfaces.getValue("s1"))!!.joinedBy(null))
        assertTrue(Surface.parse(left.surfaces.getValue("s1"))!!.joinedBy("u1"))
    }

    @Test
    fun aSurfaceReadsEveryFieldTheWireSends() {
        val wire = Wire.surface("s1", "Q3 report", "artifact", mapOf("u1" to "3", "u2" to "1"))
            .with("creatorUserId", "u2").with("chatAgentId", "a9").with("version", "07")
            .with("image", buildJsonObject { put("thumbhash", "abc") })
            .with("target", buildJsonObject { put("type", "artifact"); put("state", "available"); put("artifactId", "art1"); put("name", "Q3"); put("hasImage", false); put("version", "01") })
        assertEquals(
            Surface(
                id = "s1", type = "artifact", name = "Q3 report",
                members = listOf(SurfaceMember("u1", "3", null), SurfaceMember("u2", "1", null)),
                creatorUserId = "u2", chatAgentId = "a9",
                target = SurfaceTarget("artifact", "art1", "Q3", available = true),
                thumbhash = "abc", version = "07",
            ),
            Surface.parse(wire),
        )
        val hidden = Wire.surface("s2", "Bot", "bot").with("target", buildJsonObject { put("type", "bot"); put("state", "unavailable") })
        assertEquals(SurfaceTarget("bot", null, null, available = false), Surface.parse(hidden)!!.target)
        assertNull(Surface.parse(buildJsonObject { put("id", "s3") }))
    }

    @Test
    fun theCatalogHoldsEverySurfaceJoinedOrNotButNotArchivedOnes() {
        val catalog = AgentCatalog().withBootstrap(
            AgentClient.json.decodeFromJsonElement(
                WireDesktopBootstrap.serializer(),
                Wire.bootstrap(
                    surfaces = listOf(
                        Wire.surface("s1", "groceries", "todo"),
                        Wire.surface("s2", "Errands", "todo", mapOf("u2" to "1")),
                        Wire.surface("s3", "Plan", "document"),
                        Wire.surface("s4", "Old", "todo", archived = true),
                    ),
                ),
            ),
        )
        val surfaces = SurfaceCatalog.of(catalog)
        assertTrue(surfaces.loaded)
        assertEquals(listOf("s1", "s2", "s3"), surfaces.surfaces.map { it.id }.sorted())
        // By name as people sort it, case aside.
        assertEquals(listOf("Errands", "groceries"), surfaces.of("todo").map { it.name })
        assertTrue(surfaces.joined(surfaces["s1"]!!))
        assertFalse(surfaces.joined(surfaces["s2"]!!))

        val joined = catalog.withJoinedSurface("s2")
        // Last in the person's own list: after "1".
        assertEquals("11", SurfaceCatalog.of(joined)["s2"]!!.members.single { it.userId == Wire.USER }.orderKey)
        assertEquals(joined, joined.withJoinedSurface("s2"))
        val left = joined.withoutSurface("s2")
        assertFalse(SurfaceCatalog.of(left).let { it.joined(it["s2"]!!) })
        assertEquals(listOf("u2"), SurfaceCatalog.of(left)["s2"]!!.members.map { it.userId })
    }

    @Test
    fun aVaultSaysWhatThePersonMayDoInItAndAnOlderServerAllowsWriting() {
        val vault = Wire.surface("v1", "Policy", "vault")
        assertEquals(VaultAccess.Write, Surface.parse(vault)!!.access)
        assertFalse(Surface.parse(vault)!!.policyVault)
        val policy = Surface.parse(vault.with("access", "read").with("policyVault", true))!!
        assertEquals(VaultAccess.Read, policy.access)
        assertTrue(policy.policyVault)
        assertEquals(VaultAccess.None, Surface.parse(vault.with("access", "none"))!!.access)
        assertEquals(VaultAccess.Write, Surface.parse(vault.with("access", "write"))!!.access)
    }
}
