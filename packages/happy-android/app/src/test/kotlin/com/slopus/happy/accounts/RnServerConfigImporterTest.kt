package com.slopus.happy.accounts

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * MiniPBCoder map records and CodedOutputData string values, built
 * independently of the reader (iOS's MMKVFixtures).
 */
object MmkvFixtures {
    fun varint(value: Long): ByteArray {
        var remaining = value
        val bytes = mutableListOf<Byte>()
        do {
            val byte = (remaining and 127).toInt()
            remaining = remaining ushr 7
            bytes += (byte or if (remaining == 0L) 0 else 128).toByte()
        } while (remaining != 0L)
        return bytes.toByteArray()
    }

    fun field(value: ByteArray) = varint(value.size.toLong()) + value

    fun region(records: List<Pair<String, String?>>): ByteArray {
        // MMKV writes a random four-byte holder; 0x200000 is its lower bound.
        var bytes = varint(0x20_0000)
        for ((key, value) in records) {
            bytes += field(key.toByteArray())
            bytes += field(value?.let { field(it.toByteArray()) } ?: ByteArray(0))
        }
        return bytes
    }

    private fun put(value: Long, offset: Int, bytes: ByteArray) {
        for (i in 0 until 4) bytes[offset + i] = (value ushr (i * 8)).toByte()
    }

    fun file(region: ByteArray, headerSize: Long? = null, version: Long = 3): Pair<ByteArray, ByteArray> {
        val data = ByteArray(4).also { put(headerSize ?: region.size.toLong(), 0, it) } + region + ByteArray(64)
        val meta = ByteArray(112)
        put(MmkvStringDecoder.crc32(region), 0, meta)
        put(version, 4, meta)
        put(region.size.toLong(), 28, meta)
        return data to meta
    }

    fun write(fixture: Pair<ByteArray, ByteArray>, directory: File) {
        directory.mkdirs()
        File(directory, "server-config").writeBytes(fixture.first)
        File(directory, "server-config.crc").writeBytes(fixture.second)
    }
}

class RnServerConfigImporterTest {
    @get:Rule val folder = TemporaryFolder()
    private val key = "custom-server-url"
    private val default = "https://api.cluster-fluster.com"

    private fun decode(fixture: Pair<ByteArray, ByteArray>) = MmkvStringDecoder.string(key, fixture.first, fixture.second)

    @Test
    fun crc32MatchesZlib() {
        assertEquals(0xcbf43926L, MmkvStringDecoder.crc32("123456789".toByteArray()))
        assertEquals(0L, MmkvStringDecoder.crc32(ByteArray(0)))
    }

    @Test
    fun theLatestRecordWins() {
        val value = "https://selfhost.test/" + "a".repeat(150)
        assertEquals(value, decode(MmkvFixtures.file(MmkvFixtures.region(listOf(key to "https://old.test", "other" to "ignored", key to value)))))
    }

    @Test
    fun deletionWinsAndEmptyIsNotMissing() {
        assertNull(decode(MmkvFixtures.file(MmkvFixtures.region(listOf(key to "https://old.test", key to null)))))
        assertEquals("", decode(MmkvFixtures.file(MmkvFixtures.region(listOf(key to "")))))
    }

    @Test
    fun metadataSizeOverridesAStaleHeader() {
        val committed = MmkvFixtures.region(listOf(key to "https://committed.test"))
        val tail = MmkvFixtures.region(listOf(key to "https://uncommitted.test")).copyOfRange(4, MmkvFixtures.region(listOf(key to "https://uncommitted.test")).size)
        val fixture = MmkvFixtures.file(committed, headerSize = (committed.size + tail.size).toLong())
        tail.copyInto(fixture.first, 4 + committed.size)
        assertEquals("https://committed.test", decode(fixture))
    }

    @Test
    fun olderMetadataUsesTheHeaderSize() {
        val fixture = MmkvFixtures.file(MmkvFixtures.region(listOf(key to "https://legacy.test")), version = 2)
        assertEquals("https://legacy.test", decode(fixture))
        assertEquals("https://legacy.test", MmkvStringDecoder.string(key, fixture.first, fixture.second.copyOf(8)))
    }

    @Test
    fun tornOrUncheckedFilesAreRefused() {
        val fixture = MmkvFixtures.file(MmkvFixtures.region(listOf(key to "https://safe.test")))
        fixture.first[8] = (fixture.first[8].toInt() xor 1).toByte()
        assertThrows(MmkvStringDecoder.DecodeException::class.java) { decode(fixture) }
        assertThrows(MmkvStringDecoder.DecodeException::class.java) { MmkvStringDecoder.string(key, fixture.first, null) }
    }

    @Test
    fun malformedRecordsAreRefused() {
        assertThrows(Exception::class.java) { decode(MmkvFixtures.file(ByteArray(0), headerSize = 1000, version = 2)) }
        assertThrows(Exception::class.java) { decode(MmkvFixtures.file(byteArrayOf(0, 127, 1))) }
        val invalidUtf8 = byteArrayOf(0) + MmkvFixtures.field(key.toByteArray()) + MmkvFixtures.field(byteArrayOf(1, 255.toByte()))
        assertThrows(Exception::class.java) { decode(MmkvFixtures.file(invalidUtf8)) }
        assertThrows(Exception::class.java) { decode(MmkvFixtures.file(byteArrayOf(128.toByte()))) }
    }

    @Test
    fun futureMetadataAndExpiryAreRefused() {
        assertThrows(Exception::class.java) { decode(MmkvFixtures.file(MmkvFixtures.region(listOf(key to "https://safe.test")), version = 6)) }
        val expiring = MmkvFixtures.file(MmkvFixtures.region(listOf(key to "https://safe.test")), version = 4)
        expiring.second[104] = 1
        assertThrows(Exception::class.java) { decode(expiring) }
    }

    @Test
    fun theImportReadsWithoutWriting() {
        val dir = File(folder.root, "mmkv")
        assertEquals(ImportedServer.Confirmed(default), RnServerConfigImporter.read(dir, default))
        val fixture = MmkvFixtures.file(MmkvFixtures.region(listOf(key to "https://selfhost.test/")))
        MmkvFixtures.write(fixture, dir)
        assertEquals(ImportedServer.Confirmed("https://selfhost.test"), RnServerConfigImporter.read(dir, default))
        assertEquals(fixture.first.toList(), File(dir, "server-config").readBytes().toList())
        MmkvFixtures.write(MmkvFixtures.file(MmkvFixtures.region(listOf(key to ""))), dir)
        assertEquals(ImportedServer.Confirmed(default), RnServerConfigImporter.read(dir, default))
        MmkvFixtures.write(MmkvFixtures.file(MmkvFixtures.region(listOf(key to "ftp://invalid.test"))), dir)
        assertEquals(ImportedServer.NeedsConfirmation, RnServerConfigImporter.read(dir, default))
        MmkvFixtures.write("torn".toByteArray() to ByteArray(0), dir)
        assertEquals(ImportedServer.NeedsConfirmation, RnServerConfigImporter.read(dir, default))
    }
}
