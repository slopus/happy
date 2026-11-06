package com.slopus.happy.analytics

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The send boundary's second check, for whatever got past the types. */
class AnalyticsSchemaTest {
    @Test
    fun anUnknownEventIsDropped() {
        assertNull(AnalyticsSchema.check("screen_viewed", mapOf("screen" to "home")))
        // Desktop's own events aren't Android's.
        assertNull(AnalyticsSchema.check("onboarding_setup_result", mapOf("result" to "ok", "duration_ms" to 1)))
    }

    @Test
    fun anUnknownPropertyIsLeftOut() {
        val checked = AnalyticsSchema.check("chat_failure_action_clicked", mapOf("kind" to "network", "action" to "retry", "message" to "Couldn't reach Claude"))
        assertEquals(mapOf("kind" to "network", "action" to "retry"), checked)
    }

    @Test
    fun aValueOutsideItsSetDropsTheEvent() {
        assertNull(AnalyticsSchema.check("chat_failure_action_clicked", mapOf("kind" to "network", "action" to "/Users/kirill/secret")))
        assertNull(AnalyticsSchema.check("error_shown", mapOf("area" to "voice", "code" to "Connection refused")))
        assertNull("a required property missing", AnalyticsSchema.check("error_shown", mapOf("area" to "voice")))
        assertNull(AnalyticsSchema.check("message_sent", mapOf("source" to "chat", "model_family" to "my-company/secret-model", "has_attachment" to false, "is_steering" to false)))
        assertNull(AnalyticsSchema.check("message_sent", mapOf("source" to "chat", "task_depth" to -1, "has_attachment" to false, "is_steering" to false)))
        assertNull(AnalyticsSchema.check("message_sent", mapOf("source" to "chat", "task_depth" to "3", "has_attachment" to false, "is_steering" to false)))
        assertNull("v1's", AnalyticsSchema.check("daily_summary", mapOf("day" to 20_400)))
        assertNull("v2's", AnalyticsSchema.check("feature_used", mapOf("feature" to "run_stopped")))
        assertNull("v3's", AnalyticsSchema.check("run_stopped", emptyMap()))
    }

    @Test
    fun nullableValuesAreSentAsNullAndOptionalOnesLeftOut() {
        assertEquals(
            mapOf("error_code" to "dropped", "duration" to null),
            AnalyticsSchema.check("voice_session_error", mapOf("error_code" to "dropped")),
        )
        assertEquals(
            mapOf("agents_connected" to "1", "is_cold_start" to true),
            AnalyticsSchema.check("app_opened", mapOf("launch_count" to 3, "app_language" to "de-AT", "is_cold_start" to true, "agents_connected" to "1", "theme" to "dark")),
        )
        assertEquals("a create that worked has no error_code", mapOf("result" to "ok"), AnalyticsSchema.check("task_created", mapOf("result" to "ok")))
        assertNull(AnalyticsSchema.check("sign_in_failed", mapOf("method" to "team_server", "error_code" to null)))
    }

    @Test
    fun versionsAreNumbersAndNothingElse() {
        assertTrue(AnalyticsSchema.isVersion("1.8.0"))
        assertTrue(AnalyticsSchema.isVersion("1.2.3.4"))
        assertFalse(AnalyticsSchema.isVersion("0.40.1-preview.3"))
        assertFalse(AnalyticsSchema.isVersion("1.8.0 (kirill-macbook)"))
        assertFalse(AnalyticsSchema.isVersion("1.2.3.4.5"))
        assertFalse(AnalyticsSchema.isVersion("1." + "1".repeat(31)))
        assertEquals("0.40.1", AnalyticsSchema.version("0.40.1-preview.3"))
        assertEquals("1.8.0", AnalyticsSchema.version("1.8.0+build.7"))
        assertEquals("2026.11", AnalyticsSchema.version("2026.11-nightly+abc"))
        assertNull(AnalyticsSchema.version("1.8.0 (kirill-macbook)"))
        assertNull(AnalyticsSchema.version("dev"))
        assertNull(AnalyticsSchema.version(""))
        assertNull(AnalyticsSchema.version(null))
        assertNull(AnalyticsSchema.checkCommon(mapOf("client" to "android", "app_version" to "1.8.0-preview", "flavor" to "standard", "os" to "android", "device_class" to "phone")))
        assertNull(AnalyticsSchema.checkCommon(mapOf("client" to "android", "app_version" to "dev build", "flavor" to "standard", "os" to "android", "device_class" to "phone")))
    }
}
