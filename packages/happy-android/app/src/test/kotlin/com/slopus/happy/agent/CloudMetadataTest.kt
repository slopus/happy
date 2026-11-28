package com.slopus.happy.agent

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Zones as `GET /v0/zones` lists them: Zones v2, and what a server from before it sends. */
class CloudMetadataTest {
    private fun zone(json: String): CloudZone? = CloudZone.parse(Json.parseToJsonElement(json).jsonObject)

    @Test
    fun aZonesV2ZoneReadsItsAccessAndSettings() {
        val zone = zone(
            """{"id":"z1","name":"Finance","description":"Books","restricted":true,"color":"red","image":null,
               "members":[{"kind":"user","id":"u1"},{"kind":"team","id":"owners"},{"kind":"robot","id":"r"}],
               "bots":["b1"],"owner":"u1","settings":{"internet":"off","compute":"listed"},"agentCount":3,"version":"v","createdAt":0,"updatedAt":0}""",
        )
        assertEquals(
            CloudZone(
                "z1", "Finance", "Books", "red", restricted = true,
                // A principal of a kind this build doesn't know is left out.
                members = listOf(ZonePrincipal(ZonePrincipal.Kind.User, "u1"), ZonePrincipal(ZonePrincipal.Kind.Team, "owners")),
                internet = ZoneInternet.Off, compute = ZoneCompute.Listed,
            ),
            zone,
        )
        val open = zone("""{"id":"z2","name":"Everyday","description":"","restricted":false,"color":"gray","members":null,"bots":[],"settings":{"internet":"on","compute":"none"}}""")
        assertEquals(CloudZone("z2", "Everyday", internet = ZoneInternet.On, compute = ZoneCompute.None), open)
    }

    @Test
    fun aServerBeforeZonesV2ReadsAsCriticalMeansRestrictedAndAListRestrictsToIt() {
        // critical: the old name for restricted; bare strings are user IDs; no settings said.
        assertEquals(
            CloudZone("c", "Prod", "", "red", restricted = true, members = listOf(ZonePrincipal(ZonePrincipal.Kind.User, "u1"))),
            zone("""{"id":"c","name":"Prod","description":"","color":"red","critical":true,"isDefault":false,"members":["u1"]}"""),
        )
        assertEquals(
            CloudZone("l", "Listed", "", "blue", restricted = true, members = listOf(ZonePrincipal(ZonePrincipal.Kind.User, "u2"))),
            zone("""{"id":"l","name":"Listed","description":"","color":"blue","critical":false,"isDefault":false,"members":["u2"]}"""),
        )
        // The default zone, open to everyone: nothing of it is shown as default any more.
        assertEquals(
            CloudZone("d", "Default", "", "gray"),
            zone("""{"id":"d","name":"Default","description":"","color":"gray","critical":false,"isDefault":true,"members":null}"""),
        )
        // Anything missing takes its default; without an ID or a name it isn't a zone.
        assertEquals(CloudZone("m", "Minimal"), zone("""{"id":"m","name":"Minimal"}"""))
        assertNull(zone("""{"name":"No id"}"""))
        assertNull(CloudZone.parse(JsonObject(emptyMap())))
    }
}
