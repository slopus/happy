package com.slopus.happy.model

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** storageTypes.ts MetadataSchema / MachineMetadataSchema and profile.ts ProfileSchema, read the way zod reads them. */
class MetadataParsingTest {
    @Test
    fun pathAndHostAreRequired() {
        assertNull(SessionMetadata.parse(buildJsonObject { put("path", "/repo") }))
        assertNull(SessionMetadata.parse(buildJsonObject { put("host", "h") }))
        assertNotNull(SessionMetadata.parse("""{"path":"/repo","host":"h"}"""))
        assertNull(SessionMetadata.parse("not json"))
    }

    @Test
    fun anExplicitNullFailsAnOptionalFieldButNotANullishOne() {
        assertNull(SessionMetadata.parse("""{"path":"/r","host":"h","version":null}"""))
        val parsed = SessionMetadata.parse("""{"path":"/r","host":"h","flavor":null,"permissionMode":null}""")!!
        assertNull(parsed.flavor)
        assertNull(parsed.permissionMode)
    }

    @Test
    fun aWrongTypeAnywhereFailsTheWholeDocument() {
        assertNull(SessionMetadata.parse("""{"path":"/r","host":"h","machineId":42}"""))
        assertNull(SessionMetadata.parse("""{"path":"/r","host":"h","git":{"changedFiles":-1,"countsExact":true,"deletions":0,"insertions":0}}"""))
    }

    @Test
    fun caughtFieldsDropOnTheirOwn() {
        val parsed = SessionMetadata.parse(
            """{"path":"/r","host":"h","depth":-3,"draftUpdatedAt":"soon","draft":{"text":"x"},"lastMode":7}""",
        )!!
        assertNull(parsed.depth)
        assertNull(parsed.draftUpdatedAt)
        assertNull(parsed.draft)
        assertNull(parsed.lastMode)
    }

    @Test
    fun readsTheFieldsTheListUsesAndKeepsUnknownOnes() {
        val parsed = SessionMetadata.parse(
            buildJsonObject {
                put("path", "/Users/dev/happy")
                put("host", "laptop")
                put("homeDir", "/Users/dev")
                put("machineId", "m1")
                put("lastMeaningfulMessageAt", 1234)
                put("gitBranch", "main")
                put("futureField", true)
                putJsonObject("summary") {
                    put("text", "Fix the list")
                    put("updatedAt", 5)
                }
                putJsonObject("bot") {
                    put("id", "b1")
                    put("name", "Assistant")
                    put("username", "assistant")
                    put("workspaceId", "w")
                    put("orderKey", "1")
                    put("systemKey", JsonNull)
                }
                putJsonArray("tools") { add(kotlinx.serialization.json.JsonPrimitive("Bash")) }
            },
        )!!
        assertEquals("Fix the list", parsed.summary?.text)
        assertEquals(1234L, parsed.lastMeaningfulMessageAt)
        assertEquals("main", parsed.gitBranch)
        assertEquals("assistant", parsed.bot?.username)
        assertNull(parsed.bot?.systemKey)
        assertEquals(listOf("Bash"), parsed.tools)
        assertTrue(parsed.raw.containsKey("futureField"))
    }

    @Test
    fun aBotNameOutOfBoundsFailsTheDocument() {
        val bot = """{"id":"","name":"A","username":"a","workspaceId":"w","orderKey":"1"}"""
        assertNull(SessionMetadata.parse("""{"path":"/r","host":"h","bot":$bot}"""))
    }

    @Test
    fun machineMetadataCatchesTheRigCatalogBlockByBlock() {
        val parsed = MachineMetadata.parse(
            buildJsonObject {
                put("host", "laptop")
                put("platform", "darwin")
                put("happyCliVersion", "1.2.3")
                put("happyHomeDir", "/h/.happy")
                put("homeDir", "/h")
                put("models", "not an array")
                putJsonObject("defaults") { put("effort", 1) }
                putJsonObject("resumeSupport") { put("rpcAvailable", true) }
            },
        )!!
        assertNull(parsed.models)
        assertNull(parsed.defaults)
        assertEquals(true, parsed.resumeSupport?.rpcAvailable)
        assertNull(MachineMetadata.parse("""{"host":"laptop"}"""))
        assertNull(
            MachineMetadata.parse(
                """{"host":"l","platform":"p","happyCliVersion":"1","happyHomeDir":"/","homeDir":"/","daemonLastKnownStatus":"sleeping"}""",
            ),
        )
    }

    @Test
    fun daemonStateReadsWhatTheMachineScreenShows() {
        val state = DaemonState.parse("""{"pid":4321,"httpPort":0,"startTime":1700000000000,"startedWithCliVersion":"0.12.0"}""")!!
        assertEquals("4321", state.pid)
        assertNull(state.httpPort)
        assertEquals(1.7e12, state.startTime!!, 0.0)
        assertEquals("0.12.0", state.startedWithCliVersion)
    }

    @Test
    fun profileFallsBackToDefaultsAndNamesItself() {
        assertEquals(Profile.Defaults, Profile.parse(buildJsonObject { put("id", "x") }))
        val profile = Profile.parse(
            kotlinx.serialization.json.Json.parseToJsonElement(
                """{"id":"u","timestamp":1,"firstName":null,"lastName":null,"avatar":null,
                   "github":{"id":1,"login":"octo","name":"","avatar_url":"https://a","bio":null}}""",
            ) as kotlinx.serialization.json.JsonObject,
        )
        assertEquals("octo", profile.displayName)
        assertEquals("https://a", profile.avatarUrl)
        assertEquals(emptyList<String>(), profile.connectedServices)
    }

    @Test
    fun agentAttentionCountsOpenRequestsAndUnansweredQuestions() {
        assertEquals(AgentAttention.None, AgentAttention.parse(null))
        val attention = AgentAttention.parse(
            """{"requests":{"r1":{"tool":"Bash"}},
                "communications":{
                  "q1":{"kind":"form","form":{"questions":[{"id":"a","header":"h","question":"Which?"}]}},
                  "q2":{"kind":"form","form":{"questions":[]}},
                  "q3":{"kind":"notice"},
                  "q4":{"kind":"form","form":{"questions":[{"id":"a","header":"h","question":"Done?"}]}}},
                "completedCommunications":{"q4":{"kind":"form","status":"answered"}}}""",
        )
        assertEquals(AgentAttention(permissionRequests = 1, pendingCommunications = 2), attention)
    }

    /**
     * agentCommunications.ts `readQuestions`: a form waits on the user only if
     * a question can be answered, by an option or by writing one's own.
     * `allowCustom: false` with no options leaves nothing to answer.
     */
    @Test
    fun agentAttentionSkipsFormsWithNothingToAnswer() {
        val closed = AgentAttention.parse(
            """{"communications":{
                  "q1":{"kind":"form","form":{"questions":[{"id":"a","header":"h","question":"Which?","allowCustom":false}]}}}}""",
        )
        assertEquals(AgentAttention.None, closed)
        val withOptions = AgentAttention.parse(
            """{"communications":{
                  "q1":{"kind":"form","form":{"questions":[{"id":"a","header":"h","question":"Which?","allowCustom":false,
                    "options":[{"label":"Yes"}]}]}}}}""",
        )
        assertEquals(AgentAttention(permissionRequests = 0, pendingCommunications = 1), withOptions)
    }

    @Test
    fun sessionStatePrecedence() {
        val asking = AgentAttention(0, 1)
        val blocked = AgentAttention(1, 1)
        assertEquals(SessionState.Disconnected, resolveSessionState(blocked, thinking = true, isOnline = false))
        assertEquals(SessionState.PermissionRequired, resolveSessionState(blocked, thinking = true, isOnline = true))
        assertEquals(SessionState.InputRequired, resolveSessionState(asking, thinking = true, isOnline = true))
        assertEquals(SessionState.Thinking, resolveSessionState(AgentAttention.None, thinking = true, isOnline = true))
        assertEquals(SessionState.Waiting, resolveSessionState(AgentAttention.None, thinking = false, isOnline = true))
    }
}
