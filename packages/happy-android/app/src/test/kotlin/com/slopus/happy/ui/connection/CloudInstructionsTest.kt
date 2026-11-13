package com.slopus.happy.ui.connection

import com.slopus.happy.agent.ServerPermissions
import com.slopus.happy.agent.Surface
import com.slopus.happy.agent.SurfaceCatalog
import com.slopus.happy.agent.VaultAccess
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CloudInstructionsTest {
    @Test
    fun instructionsResolveOnlyTheMarkedVaultNotItsNameOrAccess() {
        val ordinary = Surface("ordinary", "vault", "Policy")
        val marked = Surface("actual", "vault", "Renamed", access = VaultAccess.Read, policyVault = true)
        val document = Surface("document", "document", "Policy", policyVault = true)
        assertEquals(marked, policyVault(SurfaceCatalog(listOf(ordinary, document, marked))))
        assertNull(policyVault(SurfaceCatalog(listOf(ordinary, document))))
        assertNull(policyVault(SurfaceCatalog()))
        // A malformed catalog must not choose an arbitrary Policy vault.
        assertNull(policyVault(SurfaceCatalog(listOf(marked, marked.copy(id = "duplicate")))))
    }

    @Test
    fun aServerWithPolicyEditInItsCatalogOpensItsSettingsDocumentEvenWithAPolicyVault() {
        val marked = Surface("actual", "vault", "Policy", policyVault = true)
        val catalog = SurfaceCatalog(listOf(marked), loaded = true)
        // A member: not granted, but the server serves the documents.
        val served = ServerPermissions(gated = true, granted = setOf("content.write"), known = setOf("content.write", "policy.edit"))
        assertEquals(InstructionsPlace.Document, instructionsPlace(served, catalog))
        // A new team has no Policy vault at all, only its default Files vault.
        assertEquals(InstructionsPlace.Document, instructionsPlace(served, SurfaceCatalog(listOf(Surface("files", "vault", "Files")), loaded = true)))
    }

    @Test
    fun fallbackAServerWithoutPolicyEditKeepsThePolicyVault() {
        val marked = Surface("actual", "vault", "Policy", policyVault = true)
        val before = ServerPermissions(gated = true, granted = setOf("content.write"))
        assertEquals(InstructionsPlace.Vault(marked), instructionsPlace(before, SurfaceCatalog(listOf(marked), loaded = true)))
        assertEquals(InstructionsPlace.Missing(loading = true), instructionsPlace(before, SurfaceCatalog()))
        assertEquals(InstructionsPlace.Missing(loading = false), instructionsPlace(before, SurfaceCatalog(listOf(Surface("files", "vault", "Files")), loaded = true)))
    }
}
