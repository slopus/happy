package com.slopus.happy.genui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The spec's action conformance (happy-agent docs/genui/render/conformance/
 * actions.json, copied by tools/genui/sync.sh): every element is kept and
 * drawn, and each host enables exactly what the file says.
 */
class GenUiActionsTest {
    private val conformance = Json.parseToJsonElement(File("src/test/resources/genui/conformance/actions.json").readText()).jsonObject
    private val document = GenUi.parse(conformance.getValue("document").toString())

    private val hosts = mapOf(
        "happy_agent" to (GenUiHostKind.HappyAgent to true),
        "happy_agent_without_origin" to (GenUiHostKind.HappyAgent to false),
        "cluster" to (GenUiHostKind.Cluster to true),
    )

    private fun action(key: String): Action = when (val e = document.elements[key]) {
        is Element.Button -> e.action
        is Element.Press -> e.action ?: Action.Unsupported(null)
        else -> throw AssertionError("$key is not drawn as a button or press: $e")
    }

    @Test
    fun everyHostEnablesWhatTheSpecSays() {
        val cases = conformance.getValue("cases").jsonArray
        assertTrue(cases.size >= 14)
        val wrong = cases.flatMap { c ->
            val case = c.jsonObject
            val key = case.getValue("element").jsonPrimitive.content
            case.getValue("enabled").jsonObject.mapNotNull { (host, want) ->
                val (kind, origin) = hosts.getValue(host)
                // Every host in the file reports both capabilities.
                val got = GenUiActions.enabled(action(key), kind, origin, GenUiCapabilities(secretActions = true, plugins = true))
                if (got == want.jsonPrimitive.boolean) null else "$key on $host: $got"
            }
        }
        assertTrue(wrong.joinToString("\n"), wrong.isEmpty())
    }

    @Test
    fun aCapabilityAHostDoesntReportDisablesItsActions() {
        val none = GenUiCapabilities()
        assertFalse(GenUiActions.enabled(action("secret"), GenUiHostKind.HappyAgent, true, none))
        assertFalse(GenUiActions.enabled(action("press-secret"), GenUiHostKind.HappyAgent, true, none))
        assertFalse(GenUiActions.enabled(action("cluster-secret"), GenUiHostKind.Cluster, true, none))
        assertFalse(GenUiActions.enabled(action("plugin"), GenUiHostKind.HappyAgent, true, none))
        assertFalse(GenUiActions.enabled(action("plugin"), GenUiHostKind.HappyAgent, true, GenUiCapabilities(secretActions = true)))
        assertTrue(GenUiActions.enabled(action("plugin"), GenUiHostKind.HappyAgent, true, GenUiCapabilities(plugins = true)))
        // The rest don't depend on them.
        for (key in listOf("message", "open", "copy")) assertTrue(key, GenUiActions.enabled(action(key), GenUiHostKind.HappyAgent, true, none))
    }

    @Test
    fun nothingIsDropped() {
        val keys = (conformance.getValue("document").jsonObject.getValue("elements") as JsonObject).keys
        assertEquals(keys, document.elements.keys)
    }

    @Test
    fun aSecretActionKeepsItsPrefill() {
        val secret = action("secret") as Action.Secret
        assertEquals(SecretPrefill("stripe", "Stripe test-mode keys", listOf(SecretVariable("STRIPE_SECRET_KEY", "Secret key, starts with sk_test_"))), secret.secret)
        assertEquals(Action.Plugin("linear"), action("plugin"))
        assertEquals(ClusterSecretKind.Endpoint, (action("cluster-secret") as Action.ClusterSecret).kind)
        assertEquals(ClusterSecretKind.SshKey, (action("cluster-ssh-key") as Action.ClusterSecret).kind)
    }

    private fun secret(body: String): Action {
        val d = GenUi.parse("""{"genuiRender":1,"root":"b","elements":{"b":{"type":"button","props":{"label":"Add","action":{"type":"secret","secret":$body}}}}}""")
        return (d.elements.getValue("b") as Element.Button).action
    }

    @Test
    fun aPrefillThatBreaksTheCatalogIsNoAction() {
        val one = """[{"name":"KEY"}]"""
        assertTrue(secret("""{"variables":$one}""") is Action.Secret)
        // Names: the secret's, then the variables'.
        assertTrue(secret("""{"id":"S","variables":$one}""") is Action.Unsupported)
        assertTrue(secret("""{"id":"a","variables":$one}""") is Action.Unsupported)
        assertTrue(secret("""{"id":"${"a".repeat(33)}","variables":$one}""") is Action.Unsupported)
        assertTrue(secret("""{"variables":[{"name":"1KEY"}]}""") is Action.Unsupported)
        assertTrue(secret("""{"variables":[{"name":"KEY"},{"name":"key"}]}""") is Action.Unsupported)
        // Sizes.
        assertTrue(secret("""{"variables":[]}""") is Action.Unsupported)
        assertTrue(secret("""{"variables":[${(1..65).joinToString(",") { """{"name":"K$it"}""" }}]}""") is Action.Unsupported)
        assertTrue(secret("""{"description":"${"x".repeat(2001)}","variables":$one}""") is Action.Unsupported)
        // Closed objects: nowhere to put a value.
        assertTrue(secret("""{"value":"x","variables":$one}""") is Action.Unsupported)
        assertTrue(secret("""{"environment":{"KEY":"x"},"variables":$one}""") is Action.Unsupported)
        // Wrong types.
        assertTrue(secret("""{"id":7,"variables":$one}""") is Action.Unsupported)
        assertTrue(secret("""{"variables":[{"name":"KEY","description":null}]}""") is Action.Unsupported)
    }
}
