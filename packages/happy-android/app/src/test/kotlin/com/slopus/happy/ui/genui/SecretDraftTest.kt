package com.slopus.happy.ui.genui

import com.slopus.happy.genui.SecretPrefill
import com.slopus.happy.genui.SecretVariable
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The secret form's rules: what it may save, and the create body or change patch it sends. */
class SecretDraftTest {
    private val prefill = SecretPrefill(
        "stripe",
        "Stripe test-mode keys",
        listOf(SecretVariable("STRIPE_SECRET_KEY", "starts with sk_test_"), SecretVariable("STRIPE_WEBHOOK_SECRET", null)),
    )
    private val stored = StoredSecret("stripe", "Stripe keys", listOf("OLD_KEY", "STRIPE_SECRET_KEY"), managed = false, availableToAgents = true, version = "v1")

    @Test
    fun creatingSendsTheWholeBundle() {
        val draft = SecretDraft(prefill)
        assertEquals(setOf(SecretProblem.Value), draft.problems)
        draft.rows[0].value = "sk_test_1"
        draft.rows[1].value = "whsec_1"
        assertTrue(draft.problems.isEmpty())
        val form = draft.form()
        assertNull(form.ifMatch)
        assertEquals("""{"id":"stripe","description":"Stripe test-mode keys","environment":{"STRIPE_SECRET_KEY":"sk_test_1","STRIPE_WEBHOOK_SECRET":"whsec_1"}}""", form.secret.toString())
    }

    @Test
    fun everyFieldMayChange() {
        val draft = SecretDraft(prefill)
        draft.name = "billing"
        draft.describe("Billing keys")
        draft.rows[0].name = "API_KEY"
        draft.remove(draft.rows[1])
        draft.add()
        draft.rows[1].name = "EXTRA"
        draft.rows.forEach { it.value = "x" }
        assertEquals("""{"id":"billing","description":"Billing keys","environment":{"API_KEY":"x","EXTRA":"x"}}""", draft.form().secret.toString())
    }

    @Test
    fun changingSendsAPatchAndTheVersion() {
        val draft = SecretDraft(prefill)
        draft.adopt(stored)
        // The stored description shows; the stored variable the agent didn't ask for joins the rows.
        assertEquals("Stripe keys", draft.description)
        assertEquals(listOf("STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "OLD_KEY"), draft.rows.map { it.name })
        // Only the variable not yet stored needs a value.
        assertEquals(setOf(SecretProblem.Value), draft.problems)
        draft.rows[1].value = "whsec_1"
        draft.remove(draft.rows[2])
        assertTrue(draft.problems.isEmpty())
        val form = draft.form()
        assertEquals("v1", form.ifMatch)
        // Kept: left out. Removed: null. New: set.
        assertEquals("""{"id":"stripe","description":"Stripe keys","environment":{"OLD_KEY":null,"STRIPE_WEBHOOK_SECRET":"whsec_1"}}""", form.secret.toString())
    }

    @Test
    fun aRenamedStoredVariableIsRemovedAndSetAgain() {
        val draft = SecretDraft(prefill)
        draft.adopt(stored)
        draft.rows[1].value = "whsec_1"
        draft.rows[2].name = "NEW_KEY"
        assertEquals(setOf(SecretProblem.Value), draft.problems)
        draft.rows[2].value = "n"
        assertEquals("""{"OLD_KEY":null,"STRIPE_WEBHOOK_SECRET":"whsec_1","NEW_KEY":"n"}""", (draft.form().secret["environment"] as JsonObject).toString())
    }

    @Test
    fun aDescriptionTypedByHandSurvivesOpeningTheStoredSecret() {
        val draft = SecretDraft(prefill)
        draft.describe("Mine")
        draft.adopt(stored)
        assertEquals("Mine", draft.description)
    }

    @Test
    fun anotherNameGoesBackToMakingOne() {
        val draft = SecretDraft(prefill)
        draft.adopt(stored)
        draft.name = "stripe2"
        draft.adopt(null)
        assertEquals(listOf("STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"), draft.rows.map { it.name })
        assertEquals("Stripe test-mode keys", draft.description)
        assertTrue(draft.rows.all { it.stored == null })
    }

    @Test
    fun aManagedSecretCantBeChangedHere() {
        val draft = SecretDraft(prefill)
        draft.adopt(stored.copy(managed = true))
        draft.rows.forEach { it.value = "x" }
        assertEquals(setOf(SecretProblem.Managed), draft.problems)
    }

    @Test
    fun badNamesAreSaidOnce() {
        val draft = SecretDraft(prefill.copy(id = null, description = null))
        draft.rows.forEach { it.value = "x" }
        assertEquals(setOf(SecretProblem.Name, SecretProblem.Description), draft.problems)
        draft.name = "ok"
        draft.describe("  ")
        draft.rows[1].name = "stripe_secret_key"
        assertEquals(setOf(SecretProblem.Description, SecretProblem.VariableTwice), draft.problems)
        draft.rows.clear()
        assertEquals(setOf(SecretProblem.Description, SecretProblem.NoVariables), draft.problems)
    }

    @Test
    fun forgettingClearsEveryValue() {
        val draft = SecretDraft(prefill)
        draft.rows.forEach { it.value = "secret" }
        draft.forget()
        assertTrue(draft.rows.all { it.value.isEmpty() })
    }
}
