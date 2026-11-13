package com.slopus.happy.onboarding

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.onboarding.OnboardingGate.Kind
import com.slopus.happy.onboarding.OnboardingGate.Requirement
import com.slopus.happy.onboarding.OnboardingGate.Scope
import com.slopus.happy.onboarding.OnboardingGate.Status
import com.slopus.happy.onboarding.OnboardingPlan.Step
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** A Happy Cloud server's onboarding gates, read as T09's contract v6 says, and the flow planned from them. */
class CloudOnboardingTest {
    private fun parse(text: String) = CloudOnboarding.parse(Json.parseToJsonElement(text).jsonObject)

    private val contract = """{
      "finished": false, "completed": true, "blocking": ["paymentMethod"],
      "owners": [{"userId":"u1","name":"Olga Petrova"}],
      "gates": [
        {"id":"profile","scope":"member","requirement":"required","status":"done","blocking":false,"canComplete":true,"data":{}},
        {"id":"avatar","scope":"member","requirement":"optional","status":"open","blocking":false,"canComplete":true,"data":{}},
        {"id":"adminBot","scope":"server","requirement":"optional","status":"open","blocking":false,"canComplete":true,
         "data":{"botId":"b1","agentId":"a1","name":"Chief of Staff","version":"v1","title":"Name your admin bot","avatar":{"kind":"image","thumbhash":"3OcRJYB4d3h/iIeHeEh3eIhw+j3A","source":"system"},
                 "points":["Changes settings","Connects tools","Builds a system"],"note":"Only owners can talk to it."}},
        {"id":"inference","scope":"server","requirement":"optional","status":"open","blocking":false,"canComplete":true,"data":{"connected":[],"freeModel":true}},
        {"id":"plugins","scope":"server","requirement":"optional","status":"open","blocking":false,"canComplete":true,
         "data":{"required":["github"],"plugins":[{"id":"github","name":"GitHub","required":true,"active":false}]}},
        {"id":"teammates","scope":"server","requirement":"optional","status":"skipped","blocking":false,"canComplete":true,"data":{"invited":false,"members":1}},
        {"id":"mobileApp","scope":"member","requirement":"optional","status":"open","blocking":false,"canComplete":true,
         "data":{"registered":false,"appStoreUrl":"https://apps.apple.com/x","playStoreUrl":"https://play.google.com/x"}},
        {"id":"paymentMethod","scope":"server","requirement":"required","status":"open","blocking":true,"canComplete":true,"data":{"hasPaymentMethod":false,"hasCredit":true}}
      ]
    }"""

    @Test
    fun theContractsGatesReadInTheServersOrder() {
        val onboarding = parse(contract)
        // v5: `finished` decides, not `completed`.
        assertFalse(onboarding.finished)
        assertEquals(listOf("Olga Petrova"), onboarding.owners)
        assertEquals(listOf("profile", "avatar", "adminBot", "inference", "plugins", "teammates", "mobileApp", "paymentMethod"), onboarding.gates.map { it.id })
        val bot = onboarding.gate("adminBot")!!.kind as Kind.AdminBot
        assertEquals("v1", bot.version)
        assertEquals(3, bot.points.size)
        assertEquals("Only owners can talk to it.", bot.note)
        // As cluster 696666f9 serves it (views::avatar_json), at the bot's own avatar route.
        assertEquals("/v0/bots/b1/avatar", bot.picture)
        assertEquals("3OcRJYB4d3h/iIeHeEh3eIhw+j3A", bot.thumbhash)
        assertEquals(Kind.Inference(emptyList(), freeModel = true), onboarding.gate("inference")!!.kind)
        assertEquals(listOf("github"), (onboarding.gate("plugins")!!.kind as Kind.Plugins).required)
        assertEquals("https://play.google.com/x", (onboarding.gate("mobileApp")!!.kind as Kind.MobileApp).playStoreUrl)
        assertEquals(Kind.PaymentMethod, onboarding.gate("paymentMethod")!!.kind)
        assertEquals(Status.Skipped, onboarding.gate("teammates")!!.status)
    }

    @Test
    fun fallbackAServerWithoutGatesHasNoFlow() {
        // Before gates: today's sign-in name step and home, nothing more.
        val legacy = parse("""{"completed":false,"steps":{"profile":{"done":false}}}""")
        assertTrue(legacy.legacy)
        assertTrue(legacy.finished)
        val plan = OnboardingPlan.of(legacy)
        assertNull(plan.step)
        assertNull(plan.step(showing = true))
    }

    @Test
    fun aServerBeforeFinishedIsReadByCompleted() {
        assertTrue(parse("""{"completed":true,"gates":[]}""").finished)
        assertFalse(parse("""{"completed":false,"gates":[]}""").finished)
    }

    @Test
    fun theFlowWalksTheOpenGatesInOrderThenWhatHolds() {
        val onboarding = parse(contract)
        val plan = OnboardingPlan.of(onboarding)
        assertEquals("avatar", (plan.step as Step.Gate).gate.id)
        // profile (done), avatar, adminBot, inference, plugins, teammates (skipped), mobileApp, paymentMethod.
        assertEquals(8, plan.count)
        assertEquals(6, plan.remaining)
        assertEquals(0.25f, plan.progress)
        // Each optional one taken or skipped, the payment gate is next: its screen sends them to desktop.
        val rest = onboarding.copy(gates = onboarding.gates.map { if (it.id == "paymentMethod" || !it.pending) it else it.copy(status = Status.Skipped) })
        assertEquals("paymentMethod", (OnboardingPlan.of(rest).step as Step.Gate).gate.id)
    }

    @Test
    fun aBlockingGateOnlySomeoneElseCanCompleteWaits() {
        val gate = OnboardingGate("paymentMethod", Scope.Server, Requirement.Required, Status.Open, canComplete = false, kind = Kind.PaymentMethod)
        val avatar = OnboardingGate("avatar", Scope.Member, Requirement.Optional, Status.Open, canComplete = true, kind = Kind.Avatar)
        assertEquals("avatar", (OnboardingPlan.of(CloudOnboarding(false, gates = listOf(avatar, gate))).step as Step.Gate).gate.id)
        assertEquals(Step.Waiting(listOf(gate)), OnboardingPlan.of(CloudOnboarding(false, gates = listOf(avatar.copy(status = Status.Done), gate))).step)
        // One the server can't tell yet holds them too, without a screen to act on.
        val unavailable = gate.copy(status = Status.Unavailable, canComplete = true)
        assertEquals(Step.Waiting(listOf(unavailable)), OnboardingPlan.of(CloudOnboarding(false, gates = listOf(unavailable))).step)
    }

    @Test
    fun anUnknownGateAsksForAnUpdateOnlyWhenItBlocks() {
        val unknown = parse("""{"finished":false,"gates":[{"id":"sso","scope":"member","requirement":"required","status":"open","blocking":true,"canComplete":true,"data":{}}]}""")
        assertEquals(Kind.Unknown, unknown.gates.single().kind)
        assertEquals(Step.Update, OnboardingPlan.of(unknown).step)
        // Optional: passed over on screen and never skipped here; finishing skips it.
        val optional = parse("""{"finished":false,"gates":[{"id":"sso","scope":"member","requirement":"optional","status":"open","blocking":false,"canComplete":true,"data":{}}]}""")
        assertEquals(Step.Finish, OnboardingPlan.of(optional).step)
        assertEquals(0, OnboardingPlan.of(optional).count)
        // Words this app doesn't know make a known gate unshowable too.
        val strange = parse("""{"finished":false,"gates":[{"id":"avatar","scope":"member","requirement":"required","status":"pending","blocking":true,"canComplete":true}]}""")
        assertEquals(Kind.Unknown, strange.gates.single().kind)
        assertEquals(Step.Update, OnboardingPlan.of(strange).step)
    }

    @Test
    fun anOptionalGateThePersonCantActOnNeverHoldsThem() {
        val members = OnboardingGate("teammates", Scope.Server, Requirement.Optional, Status.Open, canComplete = false, kind = Kind.Teammates(false, 1))
        val plan = OnboardingPlan.of(CloudOnboarding(false, gates = listOf(members)))
        assertEquals(Step.Finish, plan.step)
        assertEquals(0, plan.count)
    }

    @Test
    fun aFinishedFlowOnScreenStillEndsOnTheFinish() {
        val plan = OnboardingPlan.of(CloudOnboarding(true, gates = listOf(OnboardingGate("avatar", kind = Kind.Avatar, status = Status.Done))))
        assertNull(plan.step)
        assertNull(plan.step(showing = false))
        assertEquals(Step.Finish, plan.step(showing = true))
        assertEquals(1f, plan.progress)
    }

    @Test
    fun nothingLatchesAGateMadeRequiredLaterBlocksAgain() {
        val before = parse("""{"finished":true,"gates":[{"id":"teammates","scope":"server","requirement":"optional","status":"skipped","blocking":false,"canComplete":true,"data":{}}]}""")
        assertNull(OnboardingPlan.of(before).step)
        val after = parse("""{"finished":false,"blocking":["teammates"],"gates":[{"id":"teammates","scope":"server","requirement":"required","status":"open","blocking":true,"canComplete":true,"data":{"invited":false,"members":1}}]}""")
        assertEquals("teammates", (OnboardingPlan.of(after).step as Step.Gate).gate.id)
    }

    private class Server(private val answers: Map<String, Pair<Int, String>>) : Transport {
        val asked = mutableListOf<String>()
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            asked += "$method $path"
            val (status, text) = answers["$method $path"] ?: (404 to """{"error":"Not found","code":"not_found"}""")
            return TransportResponse(status, mapOf("content-type" to "application/json"), text.toByteArray())
        }

        override suspend fun close() {}
    }

    @Test
    fun skipAndCompleteGoToTheirRoutes() = runBlocking {
        val server = Server(
            mapOf(
                "POST /v0/onboarding/gates/avatar/skip" to (200 to """{"finished":true,"gates":[]}"""),
                "POST /v0/onboarding/complete" to (409 to """{"code":"onboarding_incomplete","blocking":["paymentMethod"]}"""),
            ),
        )
        val client = AgentClient(server, "t")
        assertTrue(OnboardingApi.skip(client, "avatar").finished)
        try {
            OnboardingApi.complete(client)
            fail()
        } catch (e: OnboardingIncomplete) {
            assertEquals(listOf("paymentMethod"), e.blocking)
        }
        assertEquals(listOf("POST /v0/onboarding/gates/avatar/skip", "POST /v0/onboarding/complete"), server.asked)
    }

    @Test
    fun theAdminBotIsRenamedWithItsVersionAndOnceMoreWhenItMoved() = runBlocking {
        val bodies = mutableListOf<Pair<String, String?>>()
        var patches = 0
        val server = object : Transport {
            override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                bodies += "$method $path" to headers["If-Match"]
                val (status, text) = when ("$method $path") {
                    "PATCH /v0/bots/b1" -> if (patches++ == 0) 409 to """{"error":"Changed","code":"version_conflict"}""" else 200 to """{"bot":{"id":"b1"}}"""
                    "GET /v0/bots/b1" -> 200 to """{"bot":{"id":"b1","version":"v2"}}"""
                    else -> 404 to "{}"
                }
                return TransportResponse(status, mapOf("content-type" to "application/json"), text.toByteArray())
            }

            override suspend fun close() {}
        }
        OnboardingApi.renameAdminBot(AgentClient(server, "t"), "b1", "Jarvis", "v1")
        assertEquals(listOf("PATCH /v0/bots/b1" to "v1", "GET /v0/bots/b1" to null, "PATCH /v0/bots/b1" to "v2"), bodies)
    }

    @Test
    fun theFinishOpensTheAdminBotAsTheServerSaysForThisPersonElseByRole() {
        fun bot(canTalk: String) = parse(
            """{"finished":true,"gates":[{"id":"adminBot","scope":"server","requirement":"optional","status":"done","blocking":false,"canComplete":true,
               "data":{"botId":"b1","name":"Chief of Staff"$canTalk}}]}""",
        )
        assertFalse(bot(""","canTalk":false""").opensAdminBot(byRole = true))
        assertTrue(bot(""","canTalk":true""").opensAdminBot(byRole = false))
        // FALLBACK: a server before v7 says nothing; the role decides, as before.
        assertTrue(bot("").opensAdminBot(byRole = true))
        assertFalse(bot("").opensAdminBot(byRole = false))
        assertFalse(CloudOnboarding(true).opensAdminBot(byRole = false))
    }
}
