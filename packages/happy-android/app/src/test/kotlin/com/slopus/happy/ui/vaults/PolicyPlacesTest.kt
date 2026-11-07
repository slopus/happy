package com.slopus.happy.ui.vaults

import com.slopus.happy.vaults.VaultItem
import org.junit.Assert.assertEquals
import org.junit.Test

/** The Policy vault's places that keep their names and places, found by name and parent. */
class PolicyPlacesTest {
    private fun item(name: String, kind: String, parentId: String? = null) = VaultItem(id = name, surfaceId = "p", parentId = parentId, name = name, kind = kind, version = "v1")

    @Test
    fun theTwoFoldersAtTheRootAndTheirOneDocumentEachStay() {
        val fixed = listOf(
            PolicyPlaces.fixed(item("Global", VaultItem.FOLDER), null, false),
            PolicyPlaces.fixed(item("Security", VaultItem.FOLDER), null, false),
            PolicyPlaces.fixed(item("AGENTS.md", VaultItem.FILE, "g"), "Global", true),
            PolicyPlaces.fixed(item("SECURITY.md", VaultItem.FILE, "s"), "Security", true),
        )
        assertEquals(listOf(true, true, true, true), fixed)
        val free = listOf(
            // Anything else in them, their names elsewhere, and the documents in the other's folder or deeper.
            PolicyPlaces.fixed(item("notes.md", VaultItem.FILE, "g"), "Global", true),
            PolicyPlaces.fixed(item("Global", VaultItem.FOLDER, "x"), "Archive", true),
            PolicyPlaces.fixed(item("Global", VaultItem.FILE), null, false),
            PolicyPlaces.fixed(item("SECURITY.md", VaultItem.FILE, "g"), "Global", true),
            PolicyPlaces.fixed(item("AGENTS.md", VaultItem.FILE, "d"), "Global", false),
            PolicyPlaces.fixed(item("AGENTS.md", VaultItem.FILE), null, false),
        )
        assertEquals(List(6) { false }, free)
    }
}
