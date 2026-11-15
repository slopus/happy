package com.slopus.happy.accounts

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AccountRegistryTest {
    private fun entry(id: String, order: Int) = AccountEntry(id, "https://api.cluster-fluster.com", CredentialLocation.Own, order)

    @Test
    fun aTerminalLinkGoesToTheOpenAccountElseTheOneOpenLastElseTheNewest() {
        val accounts = listOf(entry("a", 0), entry("b", 1))
        assertNull(AccountRegistry().forTerminal())
        assertNull(AccountRegistry(activeId = "agent").forTerminal())
        assertEquals("a", AccountRegistry(accounts, activeId = "a", lastHappyId = "b").forTerminal()?.id)
        assertEquals("a", AccountRegistry(accounts, activeId = "agent", lastHappyId = "a").forTerminal()?.id)
        assertEquals("b", AccountRegistry(accounts, activeId = "agent").forTerminal()?.id)
        assertEquals("b", AccountRegistry(accounts, activeId = "agent", lastHappyId = "gone").forTerminal()?.id)
    }
}
