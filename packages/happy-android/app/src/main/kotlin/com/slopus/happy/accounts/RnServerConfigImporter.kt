package com.slopus.happy.accounts

import com.slopus.happy.config.ServerConfig
import java.io.File
import java.io.FileNotFoundException

/** A recovered React Native server setting, or a request for the person to settle it first. */
sealed interface ImportedServer {
    data class Confirmed(val url: String) : ImportedServer
    data object NeedsConfirmation : ImportedServer
}

/**
 * Read-only import of the React Native app's server choice:
 * react-native-mmkv 3's unencrypted `server-config` instance
 * (serverConfig.ts, key `custom-server-url`) under `files/mmkv`. Nothing is
 * written to the React Native files. iOS's RNServerConfigImporter.
 *
 * No file means the default server. A file that can't be trusted (torn,
 * checksum mismatch, unknown metadata, not a URL) needs confirmation, since
 * sending the token to a wrong host would leak it.
 */
object RnServerConfigImporter {
    fun read(directory: File, defaultUrl: String): ImportedServer {
        val file = File(directory, "server-config")
        return try {
            val data = try {
                file.readBytes()
            } catch (_: FileNotFoundException) {
                return ImportedServer.Confirmed(defaultUrl)
            }
            val metaFile = File(directory, "server-config.crc")
            val meta = if (metaFile.exists()) metaFile.readBytes() else null
            val value = MmkvStringDecoder.string("custom-server-url", data, meta)
            if (value.isNullOrEmpty()) return ImportedServer.Confirmed(defaultUrl)
            if (ServerConfig.validate(value) != ServerConfig.Validation.Valid) return ImportedServer.NeedsConfirmation
            ImportedServer.Confirmed(value.trim().trimEnd('/'))
        } catch (_: Exception) {
            ImportedServer.NeedsConfirmation
        }
    }
}

/**
 * Decodes only the unencrypted, non-expiring MMKV map/string format of the
 * React Native server setting. Incomplete records and checksum mismatches
 * are refused rather than salvaged as MMKV does.
 */
object MmkvStringDecoder {
    class DecodeException(message: String) : Exception(message)

    fun string(key: String, data: ByteArray, metadata: ByteArray?): String? {
        if (data.size < 4) throw DecodeException("truncated")
        var size = fixed32(data, 0).toLong()
        // MMKVMetaInfo.hpp: crc 0, version 4, vector 12, actualSize 28,
        // lastConfirmed 32..103, flags 104; 112 bytes on 64-bit.
        if (metadata != null && metadata.size >= 112) {
            val version = fixed32(metadata, 4)
            if (version >= 6) throw DecodeException("unsupported metadata")
            if (version >= 4 && (104 until 112).any { metadata[it].toInt() != 0 }) throw DecodeException("unsupported metadata")
            // MMKV_IO.cpp readActualSize: v3+ metadata overrides the header.
            if (version >= 3) size = fixed32(metadata, 28).toLong()
        }
        if (size > data.size - 4) throw DecodeException("truncated")
        val region = data.copyOfRange(4, 4 + size.toInt())
        if (metadata != null && metadata.size >= 4) {
            // checkFileCRCValid: CRC32 over the data region, without the size header.
            if (crc32(region) != fixed32(metadata, 0)) throw DecodeException("checksum mismatch")
        } else if (size != 0L) {
            throw DecodeException("missing checksum")
        }
        if (size == 0L) return null
        val input = Input(region)
        input.varint32() // MiniPBCoder's item-size holder.
        var last: ByteArray? = null
        while (!input.atEnd) {
            val recordKey = utf8(input.lengthPrefixed())
            if (recordKey.isEmpty()) throw DecodeException("malformed")
            val value = input.lengthPrefixed()
            if (recordKey == key) last = value.takeIf { it.isNotEmpty() }
        }
        val bytes = last ?: return null
        // getString: the value holds another length before its UTF-8 bytes.
        val value = Input(bytes)
        val string = value.lengthPrefixed()
        if (!value.atEnd) throw DecodeException("malformed")
        return utf8(string)
    }

    /** Strict UTF-8: a replacement character would change the host. */
    private fun utf8(bytes: ByteArray): String = try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
            .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
            .decode(java.nio.ByteBuffer.wrap(bytes)).toString()
    } catch (_: java.nio.charset.CharacterCodingException) {
        throw DecodeException("malformed")
    }

    private fun fixed32(bytes: ByteArray, offset: Int): Long =
        (0 until 4).fold(0L) { acc, i -> acc or ((bytes[offset + i].toLong() and 0xff) shl (i * 8)) }

    /** IEEE CRC32, as MMKV and zlib compute it. */
    fun crc32(bytes: ByteArray): Long = java.util.zip.CRC32().apply { update(bytes) }.value

    private class Input(private val bytes: ByteArray) {
        var position = 0
        val atEnd get() = position == bytes.size

        fun varint32(): Long {
            var value = 0L
            // readRawVarint32 allows up to 10 bytes for a sign-extended int32.
            for (index in 0 until 10) {
                if (position >= bytes.size) throw DecodeException("truncated")
                val byte = bytes[position++].toInt() and 0xff
                if (index < 5) value = value or ((byte and 0x7f).toLong() shl (index * 7))
                if (byte and 0x80 == 0) return value and 0xffffffffL
            }
            throw DecodeException("malformed")
        }

        fun lengthPrefixed(): ByteArray {
            val length = varint32()
            if (length > Int.MAX_VALUE) throw DecodeException("malformed")
            if (length > bytes.size - position) throw DecodeException("truncated")
            val end = position + length.toInt()
            return bytes.copyOfRange(position, end).also { position = end }
        }
    }
}
