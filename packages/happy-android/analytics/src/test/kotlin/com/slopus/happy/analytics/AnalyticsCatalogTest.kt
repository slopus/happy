package com.slopus.happy.analytics

import com.slopus.happy.analytics.AnalyticsSchema.Field
import com.slopus.happy.analytics.AnalyticsSchema.Rule
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * The contract shared with Happy Desktop and happy-ios
 * (`docs/analytics-catalog.json`): every event listed for Android, with
 * exactly its properties and their values, and nothing more, in both the
 * send boundary's [AnalyticsSchema] and the typed [AnalyticsEvent]s.
 */
class AnalyticsCatalogTest {
    private val catalog = Json.parseToJsonElement(File("../../../docs/analytics-catalog.json").readText()).jsonObject
    private val shared = catalog.getValue("shared_enums").jsonObject

    private fun JsonObject.forAndroid(): Boolean =
        (this["clients"] as? JsonArray)?.let { clients -> clients.any { it.jsonPrimitive.content == "android" } } ?: true

    private fun values(spec: kotlinx.serialization.json.JsonElement): Set<String> = when (spec) {
        is JsonArray -> spec.map { it.jsonPrimitive.content }.toSet()
        else -> shared.getValue(spec.jsonPrimitive.content).jsonArray.map { it.jsonPrimitive.content }.toSet()
    }

    /** A property of the JSON as the schema states it. */
    private fun field(spec: JsonObject): Field {
        val rule = when {
            "enum" in spec -> Rule.OneOf(values(spec.getValue("enum")))
            else -> when (val type = spec.getValue("type").jsonPrimitive.content) {
                "count" -> Rule.Count
                "bool" -> Rule.Bool
                "version" -> Rule.Version
                "os_version" -> Rule.OsVersion
                else -> error("unknown type $type")
            }
        }
        fun flag(name: String) = (spec[name] as? JsonPrimitive)?.booleanOrNull == true
        return Field(rule, nullable = flag("nullable"), optional = flag("optional"))
    }

    private fun fields(properties: JsonObject): Map<String, Field> =
        properties.filterValues { it.jsonObject.forAndroid() }.mapValues { (_, spec) -> field(spec.jsonObject) }

    @Test
    fun theCommonPropertiesAreTheCatalogs() {
        assertEquals(fields(catalog.getValue("common").jsonObject), AnalyticsSchema.common)
    }

    @Test
    fun everyAndroidEventAndOnlyThoseHaveTheCatalogsProperties() {
        val events = catalog.getValue("events").jsonObject.filterValues { it.jsonObject.forAndroid() }
        assertEquals(events.keys, AnalyticsSchema.events.keys)
        for ((name, event) in events) {
            assertEquals(name, fields(event.jsonObject.getValue("properties").jsonObject), AnalyticsSchema.events.getValue(name))
        }
    }

    @Test
    fun theModelFamilyRuleIsTheCatalogs() {
        val rules = catalog.getValue("model_family_rule").jsonObject.getValue("rules").jsonArray.map { rule ->
            rule.jsonArray[0].jsonPrimitive.content to rule.jsonArray[1].jsonPrimitive.content
        }
        assertEquals(rules, ModelFamily.rules.map { (prefix, family) -> prefix to family.wire })
        assertEquals(values(JsonPrimitive("model_family")), ModelFamily.entries.map { it.wire }.toSet())
        assertEquals(ModelFamily.ClaudeOpus, ModelFamily.of("claude:anthropic/claude-opus-5"))
        assertEquals(ModelFamily.ClaudeOpus, ModelFamily.of("anthropic/opus-5"))
        assertEquals(ModelFamily.Gpt, ModelFamily.of("openai/gpt-5.6-sol"))
        assertEquals(ModelFamily.Kimi, ModelFamily.of("openrouter:moonshotai/kimi-k3"))
        assertEquals(ModelFamily.Other, ModelFamily.of("my-team/fine-tune"))
        assertEquals(ModelFamily.Other, ModelFamily.of("opus"))
        assertEquals(ModelFamily.Other, ModelFamily.of(""))
    }

    @Test
    fun aModelIdNeverLeavesAsItIs() {
        val sent = AnalyticsEvent.MessageSent(MessageSource.Chat, null, null, "claude:anthropic/claude-opus-5-20261101", null, null, taskDepth = null, hasAttachment = false, isSteering = false)
        assertEquals("claude_opus", AnalyticsSchema.check(sent.name, sent.properties)?.get("model_family"))
        assertEquals(false, sent.properties.values.any { it.toString().contains("anthropic") })
    }

    /** One of every typed event, every enum value used once somewhere, each passing the schema with every property it names. */
    @Test
    fun everyTypedEventPassesTheSchemaWhole() {
        val samples: List<AnalyticsEvent> = buildList {
            FailureKind.entries.forEach { add(AnalyticsEvent.ChatFailureShown(it, ProviderKind.Claude, isPool = false, ChatTarget.Bot, SessionClient.HappyAgent)) }
            ProviderKind.entries.forEach { add(AnalyticsEvent.ChatFailureShown(FailureKind.Network, it, isPool = true, ChatTarget.Session, SessionClient.Cli)) }
            ChatTarget.entries.forEach { add(AnalyticsEvent.ChatFailureShown(FailureKind.Untyped, null, isPool = false, it, SessionClient.HappyAgent)) }
            FailureAction.entries.forEach { add(AnalyticsEvent.ChatFailureActionClicked(FailureKind.UsageLimit, it)) }
            LinkTransport.entries.forEach { transport ->
                ConnectionCode.entries.forEach { code ->
                    add(AnalyticsEvent.AgentConnectionLost(transport, code, ConnectionOutcome.Recovered, DurationBucket.From10sTo30s))
                }
            }
            ConnectionOutcome.entries.forEach { add(AnalyticsEvent.AgentConnectionLost(LinkTransport.Direct, ConnectionCode.Unknown, it, DurationBucket.Over1h)) }
            DurationBucket.entries.forEach {
                add(AnalyticsEvent.VoiceSessionStopped(it))
                add(AnalyticsEvent.VoiceSessionError(VoiceError.Dropped, it))
            }
            VoiceError.entries.forEach { add(AnalyticsEvent.VoiceSessionError(it, null)) }
            ErrorArea.entries.forEach { area -> ErrorCode.entries.forEach { add(AnalyticsEvent.ErrorShown(area, it)) } }
            CrashProcess.entries.forEach { process -> CrashReason.entries.forEach { add(AnalyticsEvent.AppCrashed(process, it, "1.8.0")) } }
            add(AnalyticsEvent.AppCrashed(CrashProcess.App, CrashReason.Crash, null))
            PairingMethod.entries.forEach { method ->
                PairingStart.entries.forEach { start ->
                    add(AnalyticsEvent.MobilePairingCompleted(method, start))
                    add(AnalyticsEvent.MobilePairingCancelled(method, start))
                }
            }
            PairingError.entries.forEach { add(AnalyticsEvent.MobilePairingFailed(PairingMethod.Direct, PairingStart.Scan, it)) }
            SignInMethod.entries.forEach { method -> SignInError.entries.forEach { add(AnalyticsEvent.SignInFailed(method, it)) } }
            add(AnalyticsEvent.TeamServerSignedIn)
            PurchaseProduct.entries.forEach { product ->
                PaywallStep.entries.forEach { add(AnalyticsEvent.Paywall(it, product)) }
                PurchaseError.entries.forEach { add(AnalyticsEvent.PaywallError(product, it)) }
            }
            add(AnalyticsEvent.AppOpened(isColdStart = true))
            add(AnalyticsEvent.AppOpened(false, AnalyticsEvent.AppOpened.Configuration(Notifications.NotAsked, Bucket.ThreeOrMore)))
            Notifications.entries.forEach { add(AnalyticsEvent.AppOpened(true, AnalyticsEvent.AppOpened.Configuration(notifications = it))) }
            Bucket.entries.forEach { add(AnalyticsEvent.AppOpened(true, AnalyticsEvent.AppOpened.Configuration(agentsConnected = it))) }
            MessageSource.entries.forEach { add(AnalyticsEvent.MessageSent(it, null, null, null, null, null, taskDepth = null, hasAttachment = false, isSteering = false)) }
            ModelFamily.rules.forEach { (prefix, _) -> add(AnalyticsEvent.ConversationCreated("$prefix-9", null, null)) }
            add(AnalyticsEvent.ConversationCreated("my-team/fine-tune", null, null))
            Effort.entries.forEach {
                add(AnalyticsEvent.MessageSent(MessageSource.Chat, ChatTarget.ChiefOfStaff, SessionClient.HappyAgent, "anthropic/opus-5", ProviderKind.Anthropic, it, chiefOfStaff = true, taskDepth = 0, hasAttachment = true, isSteering = true))
                add(AnalyticsEvent.ConversationCreated("claude:anthropic/opus-5", ProviderKind.Claude, it))
            }
            add(AnalyticsEvent.ConversationCreated(null, null, null))
            add(AnalyticsEvent.BotCreated(null))
            add(AnalyticsEvent.TaskCreated(null))
            CreateError.entries.forEach {
                add(AnalyticsEvent.BotCreated(it))
                add(AnalyticsEvent.TaskCreated(it))
            }
        }
        for (event in samples) {
            val checked = AnalyticsSchema.check(event.name, event.properties)
            assertEquals(event.toString(), event.properties, checked?.filterKeys { it in event.properties })
        }
        // Every event the schema knows has a typed event.
        assertEquals(AnalyticsSchema.events.keys, samples.map { it.name }.toSet())
    }
}
