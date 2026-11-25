package com.slopus.happy.push

import com.slopus.happy.BuildConfig
import com.slopus.happy.connection.AgentConnection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Which connection registers this phone for push, and whom it registers as. */
class CloudPushAccountTest {
    private val instance = "k3x9q2m7p0a4b8c1d5e6f7g2"
    private val cloud = AgentConnection("cloud", "Acme", addedAt = 1, server = "https://acme.${BuildConfig.HAPPY_CLOUD_BASE}", instanceId = instance, userId = "member-one")
    private val team = AgentConnection("team", "Team", addedAt = 1, server = "https://happy.team.example", instanceId = instance, userId = "member-one", pushRegistrations = true)
    private val paired = AgentConnection("paired", "Studio", addedAt = 1, instanceId = instance, pushRegistrations = true, memberRead = true)

    @Test fun happyCloudRegistersWhateverItsHealthSays() {
        assertEquals(CloudPushAccount("cloud", "https://acme.${BuildConfig.HAPPY_CLOUD_BASE}", "member-one"), cloudPushAccount(cloud))
    }

    @Test fun aSignedInServerRegistersOnlyWhenItsHealthSaysItKeepsPhones() {
        assertEquals(CloudPushAccount("team", "https://happy.team.example", "member-one"), cloudPushAccount(team))
        assertNull(cloudPushAccount(team.copy(pushRegistrations = false)))
    }

    @Test fun aPairedDaemonRegistersAsItsInstallationsOnePerson() {
        assertEquals(CloudPushAccount("paired", instance, "standalone"), cloudPushAccount(paired))
        assertNull(cloudPushAccount(paired.copy(pushRegistrations = false)))
        assertNull(cloudPushAccount(paired.copy(instanceId = null)))
    }

    @Test fun aPairingOnATeamsDaemonRegistersAsTheMemberItActsFor() {
        assertEquals(CloudPushAccount("paired", instance, "member-two"), cloudPushAccount(paired.copy(userId = "member-two")))
    }

    @Test fun aSignInWithNoMemberYetIsNeverTakenForAStandalonePairing() {
        assertNull(cloudPushAccount(team.copy(userId = null)))
        assertNull(cloudPushAccount(cloud.copy(userId = null)))
    }

    /** Its daemon may be a team's: registered as `standalone` before the daemon names the member, that row is nobody's to remove. */
    @Test fun aPairingWhoseDaemonHasNotSaidWhomItActsForHasNoMemberAndRegistersNothing() {
        val unread = paired.copy(memberRead = false)
        assertNull(unread.pushMember)
        assertNull(cloudPushAccount(unread))
        assertNull(cloudPushAccount(unread.copy(userId = "member-two")))
        assertEquals("standalone", paired.pushMember)
        assertEquals("member-two", paired.copy(userId = "member-two").pushMember)
    }

    @Test fun aSignInIsNeverStandaloneEvenWhenItsServerNamesItSo() {
        assertNull(team.copy(userId = "standalone").pushMember)
        assertNull(cloudPushAccount(team.copy(userId = "standalone")))
        assertNull(cloudPushAccount(cloud.copy(userId = "standalone")))
    }

    @Test fun aConnectionThatCannotBeUsedDoesNotRegister() {
        for (connection in listOf(cloud, team, paired)) {
            assertNull(cloudPushAccount(connection.copy(revoked = true)))
            assertNull(cloudPushAccount(connection.copy(signInRequired = true)))
            assertNull(cloudPushAccount(connection.copy(profileRequired = true)))
        }
    }
}
