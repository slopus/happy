package com.slopus.happy.agent

import org.junit.Assert.assertEquals
import org.junit.Test

class PersonSeedTest {
    @Test fun theSameTeamMemberMatchesAcrossComputersAndTheirProfileSurfaces() {
        assertEquals(PersonSeed.seed("member-1", "person:computer-a"), PersonSeed.seed("member-1", "person:computer-b"))
        assertEquals("member-1", PersonSeed.seed("member-1", "person:computer-a"))
    }

    @Test fun outsideATeamTheExistingPersonFallbackIsKept() {
        assertEquals("person:computer-a", PersonSeed.seed(null, "person:computer-a"))
        assertEquals("person:computer-b", PersonSeed.seed("", "person:computer-b"))
    }
}