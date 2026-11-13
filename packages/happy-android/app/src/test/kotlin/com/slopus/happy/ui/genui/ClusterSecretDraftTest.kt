package com.slopus.happy.ui.genui

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.genui.ClusterSecretKind
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The cluster secret form's rules: what it may save, and the create body or change patch it sends (cluster API.md "Gen UI actions"). */
class ClusterSecretDraftTest {
    private fun prefill(text: String): JsonObject = AgentClient.json.parseToJsonElement(text).jsonObject

    private val stripe = prefill(
        """{"type":"endpoint","name":"Stripe API","owner":"team","uses":["egress"],
            "public":{"targets":[{"host":"api.stripe.com","pathPrefixes":["/v1"]}],
                      "algorithm":{"kind":"headers","headers":[{"name":"Authorization","prefix":"Bearer "}]}}}""",
    )

    private val key = "sk_live_0123456789abcdef"

    @Test
    fun anEndpointCreatesWithItsWholeValue() {
        val draft = ClusterSecretDraft(ClusterSecretKind.Endpoint, stripe)
        draft.allow(listOf(ClusterOwner.Me, ClusterOwner.Team))
        assertEquals(ClusterOwner.Team, draft.owner)
        assertEquals(setOf(ClusterProblem.Value), draft.problems)
        draft.headers[0].value = key
        assertTrue(draft.problems.isEmpty())
        assertEquals(
            """{"type":"endpoint","owner":"team","name":"Stripe API","description":"","public":{"targets":[{"host":"api.stripe.com","pathPrefixes":["/v1"]}],""" +
                """"algorithm":{"kind":"headers","headers":[{"name":"Authorization","prefix":"Bearer "}]}},"uses":["egress"],"material":{"Authorization":"$key"}}""",
            draft.form().toString(),
        )
        draft.mcp = true
        assertEquals("""["egress","mcp"]""", draft.form()["uses"].toString())
    }

    @Test
    fun anOwnerTheRoleCantAddIsReplacedOrRefused() {
        val draft = ClusterSecretDraft(ClusterSecretKind.Endpoint, stripe)
        draft.headers[0].value = key
        assertEquals(setOf(ClusterProblem.Owner), draft.problems)
        draft.allow(listOf(ClusterOwner.Me))
        assertEquals(ClusterOwner.Me, draft.owner)
        assertTrue(draft.problems.isEmpty())
        draft.allow(emptyList())
        assertEquals(setOf(ClusterProblem.Owner), draft.problems)
    }

    @Test
    fun injectableValuesFollowTheClusterRule() {
        assertFalse(ClusterSecretDraft.injectable("short"))
        assertFalse(ClusterSecretDraft.injectable("0123456789abcdef[x]"))
        assertFalse(ClusterSecretDraft.injectable("0123456789abcdef\u00e9"))
        assertTrue(ClusterSecretDraft.injectable("0123456789abcdef ~"))
        assertFalse(ClusterSecretDraft.injectable("a".repeat(4097)))
    }

    @Test
    fun headersAndTargetsAreChecked() {
        val draft = ClusterSecretDraft(ClusterSecretKind.Endpoint, stripe)
        draft.allow(listOf(ClusterOwner.Team))
        draft.headers[0].value = key
        draft.addHeader()
        draft.headers[1].name = "authorization"
        draft.headers[1].value = key
        assertTrue(ClusterProblem.Headers in draft.problems)
        draft.headers[1].name = "X Bad"
        assertTrue(ClusterProblem.Headers in draft.problems)
        draft.headers.removeAt(1)
        draft.targets[0].path = "v1"
        assertEquals(setOf(ClusterProblem.Targets), draft.problems)
    }

    @Test
    fun aChangeSendsWordsTypedValuesAndTheVersion() {
        val stored = ClusterStored(
            "c0123456789abcdefghijklm",
            ClusterSecretKind.Environment,
            "Deploy",
            "Deploy keys",
            prefill("""{"variables":["API_KEY","REGION"]}"""),
            "v3",
            manage = true,
        )
        val draft = ClusterSecretDraft(ClusterSecretKind.Environment, prefill("""{"type":"environment","id":"c0123456789abcdefghijklm","name":"Ignored"}"""))
        draft.adopt(stored)
        assertTrue(draft.changing)
        assertEquals(listOf("API_KEY", "REGION"), draft.variables.map { it.name })
        // Nothing typed keeps every value: no material at all.
        assertEquals("""{"name":"Deploy","description":"Deploy keys","version":"v3"}""", draft.form().toString())
        draft.variables[0].value = "new"
        assertEquals("""{"name":"Deploy","description":"Deploy keys","material":{"API_KEY":"new","REGION":null},"version":"v3"}""", draft.form().toString())
    }

    @Test
    fun aSecretThePersonCantManageCantBeChanged() {
        val stored = ClusterStored("c0123456789abcdefghijklm", ClusterSecretKind.SshKey, "Deploy key", "", prefill("""{"hosts":["github.com"]}"""), "v1", manage = false)
        val draft = ClusterSecretDraft(ClusterSecretKind.SshKey, prefill("""{"type":"ssh_key","id":"c0123456789abcdefghijklm"}"""))
        draft.adopt(stored)
        assertEquals(setOf(ClusterProblem.Unchangeable), draft.problems)
    }

    @Test
    fun anSshKeyNeedsHostsAndAKey() {
        val draft = ClusterSecretDraft(ClusterSecretKind.SshKey, prefill("""{"type":"ssh_key","name":"Deploy key","public":{"hosts":["github.com"],"ports":[2222],"fingerprint":"SHA256:theirs"}}"""))
        draft.allow(listOf(ClusterOwner.Me))
        assertEquals(setOf(ClusterProblem.Key), draft.problems)
        draft.privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n"
        draft.hosts = " "
        assertEquals(setOf(ClusterProblem.Hosts), draft.problems)
        draft.hosts = "github.com, gitlab.com"
        val form = draft.form()
        // Ports it doesn't edit go as they came; a fingerprint is the store's to derive.
        assertEquals(listOf("2222"), draft.ports)
        assertEquals("""{"ports":[2222],"hosts":["github.com","gitlab.com"]}""", form["public"].toString())
        assertEquals("""["ssh"]""", form["uses"].toString())
        assertEquals("""{"privateKey":"${draft.privateKey.replace("\n", "\\n")}"}""", form["material"].toString())
    }

    @Test
    fun aGitCredentialSignsOnlyWithAnSshKey() {
        val draft = ClusterSecretDraft(
            ClusterSecretKind.GitCredential,
            prefill("""{"type":"git_credential","name":"GitHub","public":{"server":"github.com","method":{"kind":"token"},"operations":["read","sign"]}}"""),
        )
        draft.allow(listOf(ClusterOwner.Me))
        draft.token = "ghp_0123456789abcdef"
        assertTrue(draft.problems.isEmpty())
        assertEquals("""{"server":"github.com","method":{"kind":"token"},"operations":["read"]}""", draft.form()["public"].toString())
        assertEquals("""{"token":"ghp_0123456789abcdef"}""", draft.form()["material"].toString())
        draft.toggle(GitOperation.Read)
        assertEquals(setOf(ClusterProblem.Operations), draft.problems)
        draft.method = GitMethod.Password
        draft.toggle(GitOperation.Write)
        assertEquals(setOf(ClusterProblem.Username, ClusterProblem.Value), draft.problems)
        draft.username = "octo"
        draft.password = "correct horse battery"
        assertTrue(draft.problems.isEmpty())
        assertEquals("""{"server":"github.com","method":{"kind":"password","username":"octo"},"operations":["write"]}""", draft.form()["public"].toString())
    }

    @Test
    fun forgettingClearsEveryValue() {
        val draft = ClusterSecretDraft(ClusterSecretKind.Endpoint, stripe)
        draft.headers[0].value = key
        draft.token = "x"
        draft.privateKey = "y"
        draft.forget()
        assertEquals("", draft.headers[0].value)
        assertEquals("", draft.token)
        assertEquals("", draft.privateKey)
    }
}
