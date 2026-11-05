package com.slopus.happy.vaults

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class VaultRetentionPresetTest {
    private val timeMachine = VaultRetention(null, null, 1, listOf(VaultRetentionTier(1, 1), VaultRetentionTier(30, 7)), 30)

    @Test
    fun aNewVaultIsTimeMachineWithAThirtyDayTrash() {
        assertEquals(timeMachine, VaultRetention())
        assertEquals(VaultRetentionPreset.TimeMachine, VaultRetentionPreset.of(VaultRetention()))
        assertEquals(
            listOf(VaultRetentionPreset.TimeMachine, VaultRetentionPreset.KeepEverything, VaultRetentionPreset.LastTen, VaultRetentionPreset.Custom),
            VaultRetentionPreset.offered,
        )
    }

    @Test
    fun aPresetSetsTheVersionsAndKeepsTheTrash() {
        val current = timeMachine.copy(trashDays = null)
        assertEquals(VaultRetention(null, null, 0, emptyList(), null), VaultRetentionPreset.KeepEverything.applied(current))
        assertEquals(VaultRetention(10, null, 0, emptyList(), null), VaultRetentionPreset.LastTen.applied(current))
        assertEquals(current, VaultRetentionPreset.Custom.applied(current))
        assertEquals(VaultRetentionPreset.LastTen, VaultRetentionPreset.of(VaultRetention(10, null, 0, emptyList(), 7)))
        assertEquals(VaultRetentionPreset.TimeMachine, VaultRetentionPreset.of(current))
    }

    @Test
    fun anythingElseIsCustom() {
        assertEquals(VaultRetentionPreset.Custom, VaultRetentionPreset.of(timeMachine.copy(keepAllDays = 2)))
        assertEquals(VaultRetentionPreset.Custom, VaultRetentionPreset.of(VaultRetention(10, 365, 0, emptyList(), 30)))
        assertEquals(VaultRetentionPreset.Custom, VaultRetentionPreset.of(timeMachine.copy(thinning = listOf(VaultRetentionTier(1, 1)))))
    }

    @Test
    fun whatTheDaemonWouldRefuse() {
        assertNull(VaultRetentionPreset.problem(timeMachine))
        assertEquals(VaultRetentionPreset.Problem.MaxVersions, VaultRetentionPreset.problem(timeMachine.copy(maxVersions = 0)))
        assertEquals(VaultRetentionPreset.Problem.MaxAge, VaultRetentionPreset.problem(timeMachine.copy(maxAgeDays = 40_000)))
        assertEquals(VaultRetentionPreset.Problem.KeepAll, VaultRetentionPreset.problem(timeMachine.copy(keepAllDays = -1)))
        assertEquals(VaultRetentionPreset.Problem.TooManyTiers, VaultRetentionPreset.problem(timeMachine.copy(thinning = (1..9).map { VaultRetentionTier(it, 1) })))
        assertEquals(VaultRetentionPreset.Problem.Tier, VaultRetentionPreset.problem(timeMachine.copy(thinning = listOf(VaultRetentionTier(1, 0)))))
        assertEquals(VaultRetentionPreset.Problem.TierOrder, VaultRetentionPreset.problem(timeMachine.copy(thinning = listOf(VaultRetentionTier(30, 7), VaultRetentionTier(30, 1)))))
        assertEquals(VaultRetentionPreset.Problem.Trash, VaultRetentionPreset.problem(timeMachine.copy(trashDays = 0)))
    }

    @Test
    fun thePolicyIsSentWholeWithItsNulls() {
        assertEquals(
            """{"maxVersions":null,"maxAgeDays":null,"keepAllDays":1,"thinning":[{"afterDays":1,"everyDays":1},{"afterDays":30,"everyDays":7}],"trashDays":null}""",
            timeMachine.copy(trashDays = null).json().toString(),
        )
    }
}

class VaultPreviewTest {
    @Test
    fun eachKindOpensItsOwnWay() {
        fun kind(name: String, type: String?, size: Long = 10, kind: String = VaultItem.FILE) = VaultPreview.kind(vaultItem("e", "v", name, kind = kind, size = size, mediaType = type))
        assertEquals(VaultPreviewKind.Picture, kind("a.png", "image/png"))
        assertEquals(VaultPreviewKind.Video, kind("a.mp4", "video/mp4"))
        assertEquals(VaultPreviewKind.Pdf, kind("a.pdf", "application/pdf"))
        assertEquals(VaultPreviewKind.Text, kind("a.md", "text/markdown; charset=utf-8"))
        assertEquals(VaultPreviewKind.Text, kind("main.kt", "application/octet-stream"))
        assertEquals(VaultPreviewKind.Other, kind("big.log", "text/plain", size = VaultPreview.TEXT_LIMIT + 1))
        assertEquals(VaultPreviewKind.Other, kind("a.zip", "application/zip"))
        assertEquals(VaultPreviewKind.App, kind("launch.artifact", null, kind = VaultItem.ARTIFACT))
        assertEquals(VaultPreviewKind.Other, kind("docs", null, kind = VaultItem.FOLDER))
    }
}

class VaultNamesTest {
    @Test
    fun anAppKeepsItsUnseenSuffixThroughARename() {
        val app = vaultItem("e", "v", "Launch.ARTIFACT", kind = VaultItem.ARTIFACT)
        assertEquals("Launch", app.shownName)
        assertEquals("landing.artifact", com.slopus.happy.ui.vaults.newName(app, " landing "))
        // Its name as shown, untouched, is no change at all.
        assertEquals("Launch.ARTIFACT", com.slopus.happy.ui.vaults.newName(app, "Launch"))
        assertEquals("notes.txt", com.slopus.happy.ui.vaults.newName(vaultItem("f", "v", "a.txt"), "notes.txt"))
    }

    @Test
    fun aFolderOrPlainFileCantTakeTheSuffix() {
        assertNull(com.slopus.happy.ui.vaults.newName(vaultItem("f", "v", "a.txt"), "a.artifact"))
        assertNull(com.slopus.happy.ui.vaults.newName(vaultItem("d", "v", "Docs", kind = VaultItem.FOLDER), "Docs.Artifact"))
    }

    @Test
    fun noScreenShowsTheSuffix() {
        assertEquals("launch", VaultNames.shown("launch.artifact"))
        assertEquals("notes.txt", VaultNames.shown("notes.txt"))
        assertEquals(".artifact", VaultNames.shown(".artifact"))
        assertEquals("/Apps/launch/img/hero.png", VaultNames.shownPath("/Apps/launch.artifact/img/hero.png"))
        assertEquals("/", VaultNames.shownPath("/"))
    }

    @Test
    fun anArtifactDownloadsAsItsBundle() {
        assertEquals("launch.artifact", VaultDownloads.name(vaultItem("e", "v", "launch.artifact", kind = VaultItem.ARTIFACT)))
        assertEquals("Reports.zip", VaultDownloads.name(vaultItem("f", "v", "Reports", kind = VaultItem.FOLDER)))
        assertEquals("a.txt", VaultDownloads.name(vaultItem("a", "v", "a.txt")))
    }
}
