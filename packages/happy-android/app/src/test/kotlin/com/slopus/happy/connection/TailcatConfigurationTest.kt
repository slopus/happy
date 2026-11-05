package com.slopus.happy.connection

import io.tailcat.NodePrivateKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class TailcatConfigurationTest {
    @Test fun relayFirstPreservesEachClientsNodeKeyMapAndTimeout() {
        val keys = List(3) { NodePrivateKey.generate() }
        for (key in keys) {
            val config = TailcatTransport.tailcatConfiguration(key, 12_345)
            assertTrue(config.relayFirst)
            assertEquals(12_345L, config.connectTimeoutMillis)
            assertSame(key, config.privateKey)
            assertSame(TailcatTransport.tailcatConfiguration(keys.first(), 20_000).mapProvider, config.mapProvider)
        }
        assertEquals(3, keys.map { it.publicKey }.toSet().size)
    }
}