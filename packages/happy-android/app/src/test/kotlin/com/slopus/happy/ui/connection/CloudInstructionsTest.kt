package com.slopus.happy.ui.connection

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
}