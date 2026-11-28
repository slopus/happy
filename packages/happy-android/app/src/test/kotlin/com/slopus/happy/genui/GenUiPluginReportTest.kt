package com.slopus.happy.genui

import com.slopus.happy.plugins.InstallationStatus
import com.slopus.happy.plugins.PluginInstallation
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A `plugin` element's setup report (happy-cluster API.md "Gen UI
 * actions"): when it applies, when it is sent, what it sends, and how the
 * answer is read.
 */
class GenUiPluginReportTest {
    private val both = GenUiCapabilities(plugins = true, artifactPluginActions = true)

    private fun installation(plugin: String, status: InstallationStatus, id: String = "i-$plugin") = PluginInstallation(
        id = id, pluginKey = plugin, name = plugin, ordinal = 1, label = null, status = status, authMethod = null, image = null, available = true,
    )

    @Test
    fun itAppliesOnlyToAnArtifactVersionWithAnOriginOnAComputerThatTakesReports() {
        assertTrue(GenUiPluginReport.applies(both, artifact = true, origin = true))
        assertFalse("direct Gen UI", GenUiPluginReport.applies(both, artifact = false, origin = true))
        assertFalse("no origin agent", GenUiPluginReport.applies(both, artifact = true, origin = false))
        assertFalse("no artifactPluginActions", GenUiPluginReport.applies(GenUiCapabilities(plugins = true), artifact = true, origin = true))
        assertFalse("no plugins", GenUiPluginReport.applies(GenUiCapabilities(artifactPluginActions = true), artifact = true, origin = true))
        assertFalse(GenUiPluginReport.applies(GenUiCapabilities(), artifact = true, origin = true))
    }

    @Test
    fun theCapabilityIsOffUnlessReported() {
        assertFalse(GenUiCapabilities().artifactPluginActions)
        // It decides only the report: the plugin action itself still runs on `plugins` alone.
        assertTrue(GenUiActions.enabled(Action.Plugin("linear"), GenUiHostKind.Cluster, origin = true, GenUiCapabilities(plugins = true)))
    }

    @Test
    fun onlyAnActiveInstallationOfThatPluginCountsAsSetUp() {
        assertFalse(GenUiPluginReport.setUp(emptyList(), "linear"))
        assertFalse(GenUiPluginReport.setUp(listOf(installation("linear", InstallationStatus.NeedsSetup)), "linear"))
        assertFalse(GenUiPluginReport.setUp(listOf(installation("linear", InstallationStatus.MethodUnavailable)), "linear"))
        assertFalse(GenUiPluginReport.setUp(listOf(installation("github", InstallationStatus.Active)), "linear"))
        assertTrue(
            GenUiPluginReport.setUp(
                listOf(installation("linear", InstallationStatus.NeedsSetup, "a"), installation("linear", InstallationStatus.Active, "b")),
                "linear",
            ),
        )
    }

    @Test
    fun theBodyIsTheSubmissionAndTheElementAlone() {
        val body = GenUiPluginReport.body("s1", "get")
        assertEquals(JsonObject(mapOf("id" to JsonPrimitive("s1"), "element" to JsonPrimitive("get"))), body)
        assertEquals(setOf("id", "element"), body.keys)
        assertEquals("/v0/artifacts/a%2Fb/versions/3/actions", GenUiPluginReport.path("a/b", 3) { it.replace("/", "%2F") })
    }

    @Test
    fun aTakenReportIsReadTolerantly() {
        val body = Json.parseToJsonElement(
            """{"pluginId":"linear","installations":[{"id":"i1","label":"Work","toolPrefix":"linear_"},{"label":"no id"},7],"messageId":"m1"}""",
        )
        val want = PluginReported("linear", listOf(ReportedInstallation("i1", "Work", "linear_")), "m1")
        assertEquals(PluginReportAnswer.Reported(want), GenUiPluginReport.answer(201, null, body))
        assertEquals(PluginReportAnswer.Reported(want), GenUiPluginReport.answer(200, null, body))
        // Whatever the body says, a 2xx was taken.
        assertEquals(PluginReportAnswer.Reported(PluginReported(null, emptyList(), null)), GenUiPluginReport.answer(200, null, null))
    }

    @Test
    fun refusalsAndFailuresAreToldApart() {
        assertEquals(PluginReportAnswer.NotSetUp, GenUiPluginReport.answer(409, "not_set_up", null))
        assertEquals(PluginReportAnswer.Refused, GenUiPluginReport.answer(409, "no_origin", null))
        assertEquals(PluginReportAnswer.Refused, GenUiPluginReport.answer(404, "not_found", null))
        assertEquals(PluginReportAnswer.Refused, GenUiPluginReport.answer(403, null, null))
        assertEquals(PluginReportAnswer.Retry, GenUiPluginReport.answer(500, null, null))
        assertEquals(PluginReportAnswer.Retry, GenUiPluginReport.answer(503, null, null))
        assertEquals(PluginReportAnswer.Retry, GenUiPluginReport.answer(429, null, null))
    }

    @Test
    fun aRunSendsOnceItsPluginIsActiveAndOnlyOneAttemptAtATime() {
        val run = PluginReportRun("g1", 2, "get", "linear", "s1")
        assertFalse("not set up yet", run.seen(listOf(installation("linear", InstallationStatus.NeedsSetup))))
        val active = listOf(installation("linear", InstallationStatus.Active))
        assertTrue(run.seen(active))
        assertFalse("already on its way", run.seen(active))
        assertFalse(run.resend())
        assertFalse(run.answered(PluginReportAnswer.Reported(PluginReported("linear", emptyList(), "m1"))))
        assertTrue(run.finished)
        assertTrue(run.reported)
        assertFalse("done: never again", run.seen(active))
        assertFalse(run.resend())
    }

    @Test
    fun aFailedAttemptIsSentAgainUnderTheSameSubmission() {
        val run = PluginReportRun("g1", 2, "get", "linear", "s1")
        val active = listOf(installation("linear", InstallationStatus.Active))
        assertTrue(run.seen(active))
        assertTrue("retry later", run.answered(PluginReportAnswer.Retry))
        assertFalse(run.finished)
        assertTrue(run.resend())
        assertEquals("s1", run.submission)
        // The server didn't see it set up yet: nothing, until the page sees it again.
        assertFalse(run.answered(PluginReportAnswer.NotSetUp))
        assertFalse(run.finished)
        assertTrue(run.seen(active))
        assertFalse(run.answered(PluginReportAnswer.Refused))
        assertTrue(run.finished)
        assertFalse("refused: not marked done", run.reported)
        assertFalse(run.seen(active))
    }
}
