package com.slopus.happy.documents.yjs

import java.math.BigDecimal

/**
 * A value as lib0 encodes it (`writeAny`): what Yjs keeps in maps,
 * attributes and formats. Objects keep their keys in order, as a
 * JavaScript object does, so encoding is the same bytes JavaScript writes.
 * iOS's `YAny`.
 */
sealed class YAny {
    data object Undefined : YAny()
    data object Null : YAny()
    data class Bool(val value: Boolean) : YAny()

    class Number(val value: Double) : YAny() {
        override fun equals(other: Any?) = other is Number && other.value == value
        override fun hashCode() = if (value == 0.0) 0 else value.hashCode()
        override fun toString() = "Number($value)"
    }

    data class BigInt(val value: Long) : YAny()
    data class Str(val value: String) : YAny()
    data class Array(val items: List<YAny>) : YAny()

    /** Compares by keys and values, whatever the order. */
    class Object(val pairs: List<Pair<String, YAny>>) : YAny() {
        override fun equals(other: Any?): Boolean {
            if (other !is Object || other.pairs.size != pairs.size) return false
            for ((key, value) in pairs) {
                val found = other.pairs.firstOrNull { it.first == key } ?: return false
                if (found.second != value) return false
            }
            return true
        }

        override fun hashCode() = pairs.sumOf { it.first.hashCode() xor it.second.hashCode() }
        override fun toString() = "Object($pairs)"
    }

    class Bytes(val value: ByteArray) : YAny() {
        override fun equals(other: Any?) = other is Bytes && other.value.contentEquals(value)
        override fun hashCode() = value.contentHashCode()
    }

    operator fun get(key: String): YAny? = (this as? Object)?.pairs?.firstOrNull { it.first == key }?.second

    val stringValue: String? get() = (this as? Str)?.value
    val boolValue: Boolean? get() = (this as? Bool)?.value
    val numberValue: Double? get() = (this as? Number)?.value
    val isNullish: Boolean get() = this == Null || this == Undefined

    /** `JSON.stringify`: no spaces, keys in order, undefined left out of objects. */
    val jsonString: String get() = StringBuilder().also { writeJSON(it) }.toString()

    private fun writeJSON(out: StringBuilder) {
        when (this) {
            Undefined, Null -> out.append("null")
            is Bool -> out.append(if (value) "true" else "false")
            is Number -> out.append(jsNumber(value))
            is BigInt -> out.append(value)
            is Str -> quote(value, out)
            is Bytes -> {
                // A Uint8Array stringifies as an object of indices.
                out.append('{')
                value.forEachIndexed { i, byte -> if (i > 0) out.append(','); out.append('"').append(i).append("\":").append(byte.toInt() and 0xFF) }
                out.append('}')
            }
            is Array -> {
                out.append('[')
                items.forEachIndexed { i, item ->
                    if (i > 0) out.append(',')
                    if (item == Undefined) out.append("null") else item.writeJSON(out)
                }
                out.append(']')
            }
            is Object -> {
                out.append('{')
                var first = true
                for ((key, value) in pairs) {
                    if (value == Undefined) continue
                    if (!first) out.append(',')
                    first = false
                    quote(key, out)
                    out.append(':')
                    value.writeJSON(out)
                }
                out.append('}')
            }
        }
    }

    companion object {
        /** `JSON.parse`. Numbers come back as doubles, as in JavaScript. */
        fun parseJSON(text: String): YAny {
            val parser = JsonScanner(text)
            val value = parser.value()
            parser.skipSpace()
            if (!parser.atEnd) throw YError.Malformed("trailing JSON")
            return value
        }

        /** A number as JavaScript prints it. */
        fun jsNumber(n: Double): String {
            if (!n.isFinite()) return "null"
            if (n == Math.rint(n) && kotlin.math.abs(n) < 1e21) return n.toLong().toString()
            val decimal = BigDecimal(n.toString())
            val exponent = decimal.precision() - decimal.scale() - 1
            if (exponent in -7..20) return decimal.stripTrailingZeros().toPlainString()
            val digits = decimal.unscaledValue().abs().toString().trimEnd('0')
            val mantissa = if (digits.length > 1) digits[0] + "." + digits.substring(1) else digits
            return (if (n < 0) "-" else "") + mantissa + "e" + (if (exponent >= 0) "+" else "-") + kotlin.math.abs(exponent)
        }

        private fun quote(s: String, out: StringBuilder) {
            out.append('"')
            for (c in s) {
                when (c) {
                    '"' -> out.append("\\\"")
                    '\\' -> out.append("\\\\")
                    '\n' -> out.append("\\n")
                    '\r' -> out.append("\\r")
                    '\t' -> out.append("\\t")
                    '\b' -> out.append("\\b")
                    '\u000C' -> out.append("\\f")
                    else -> if (c.code < 0x20) out.append(String.format("\\u%04x", c.code)) else out.append(c)
                }
            }
            out.append('"')
        }
    }
}

sealed class YError(message: String) : Exception(message) {
    class Malformed(message: String) : YError(message)
    class Unexpected(message: String) : YError(message)
}

private class JsonScanner(private val text: String) {
    private var index = 0
    val atEnd get() = index >= text.length

    fun skipSpace() {
        while (index < text.length && (text[index] == ' ' || text[index] == '\t' || text[index] == '\n' || text[index] == '\r')) index++
    }

    fun value(): YAny {
        skipSpace()
        if (index >= text.length) throw YError.Malformed("JSON ends")
        when (text[index]) {
            '{' -> {
                index++
                val pairs = ArrayList<Pair<String, YAny>>()
                skipSpace()
                if (index < text.length && text[index] == '}') { index++; return YAny.Object(pairs) }
                while (true) {
                    skipSpace()
                    val key = (value() as? YAny.Str)?.value ?: throw YError.Malformed("JSON key")
                    skipSpace()
                    if (index >= text.length || text[index] != ':') throw YError.Malformed("JSON colon")
                    index++
                    val item = value()
                    val existing = pairs.indexOfFirst { it.first == key }
                    if (existing >= 0) pairs[existing] = key to item else pairs += key to item
                    skipSpace()
                    if (index >= text.length) throw YError.Malformed("JSON object")
                    if (text[index] == ',') { index++; continue }
                    if (text[index] == '}') { index++; return YAny.Object(pairs) }
                    throw YError.Malformed("JSON object")
                }
            }
            '[' -> {
                index++
                val items = ArrayList<YAny>()
                skipSpace()
                if (index < text.length && text[index] == ']') { index++; return YAny.Array(items) }
                while (true) {
                    items += value()
                    skipSpace()
                    if (index >= text.length) throw YError.Malformed("JSON array")
                    if (text[index] == ',') { index++; continue }
                    if (text[index] == ']') { index++; return YAny.Array(items) }
                    throw YError.Malformed("JSON array")
                }
            }
            '"' -> return YAny.Str(string())
            't' -> { word("true"); return YAny.Bool(true) }
            'f' -> { word("false"); return YAny.Bool(false) }
            'n' -> { word("null"); return YAny.Null }
            else -> {
                val start = index
                while (index < text.length && text[index] in "+-0123456789.eE") index++
                val number = text.substring(start, index).toDoubleOrNull() ?: throw YError.Malformed("JSON number")
                return YAny.Number(number)
            }
        }
    }

    private fun word(w: String) {
        if (!text.startsWith(w, index)) throw YError.Malformed("JSON word")
        index += w.length
    }

    private fun string(): String {
        index++
        val out = StringBuilder()
        while (index < text.length) {
            val c = text[index]
            if (c == '"') { index++; return out.toString() }
            if (c == '\\') {
                index++
                if (index >= text.length) break
                val escape = text[index++]
                when (escape) {
                    'n' -> out.append('\n')
                    'r' -> out.append('\r')
                    't' -> out.append('\t')
                    'b' -> out.append('\b')
                    'f' -> out.append('\u000C')
                    'u' -> {
                        if (index + 4 > text.length) throw YError.Malformed("JSON escape")
                        val code = text.substring(index, index + 4).toIntOrNull(16) ?: throw YError.Malformed("JSON escape")
                        out.append(code.toChar())
                        index += 4
                    }
                    else -> out.append(escape)
                }
                continue
            }
            out.append(c)
            index++
        }
        throw YError.Malformed("JSON string")
    }
}

/** lib0's `encoding`: variable-length integers, strings and `any`. */
class YEncoder {
    private var buffer = ByteArray(64)
    var size = 0
        private set

    val bytes: ByteArray get() = buffer.copyOf(size)

    private fun ensure(extra: Int) {
        if (size + extra > buffer.size) buffer = buffer.copyOf(maxOf(buffer.size * 2, size + extra))
    }

    fun write(byte: Int) {
        ensure(1)
        buffer[size++] = byte.toByte()
    }

    fun write(data: ByteArray) {
        ensure(data.size)
        data.copyInto(buffer, size)
        size += data.size
    }

    fun writeVarUint(value: Long) {
        var num = value
        while (num > 0x7F || num < 0) {
            write((0x80 or (num and 0x7F).toInt()))
            num = num ushr 7
        }
        write(num.toInt())
    }

    fun writeVarUint(value: Int) = writeVarUint(value.toLong())

    /** Sign in the first byte's 7th bit, as lib0 writes it. */
    fun writeVarInt(value: Long) {
        val negative = value < 0
        var num = if (negative) -value else value
        write(((if (num > 0x3F) 0x80 else 0) or (if (negative) 0x40 else 0) or (num and 0x3F).toInt()))
        num = num ushr 6
        while (num > 0) {
            write(((if (num > 0x7F) 0x80 else 0) or (num and 0x7F).toInt()))
            num = num ushr 7
        }
    }

    /**
     * A JavaScript string held as UTF-16, encoded as `TextEncoder` would: a
     * lone surrogate becomes U+FFFD (the JDK's encoder writes '?').
     */
    fun writeVarString(string: String) {
        val utf8 = utf8(string)
        writeVarUint(utf8.size)
        write(utf8)
    }

    fun writeVarUint8Array(data: ByteArray) {
        writeVarUint(data.size)
        write(data)
    }

    fun writeAny(value: YAny) {
        when (value) {
            YAny.Undefined -> write(127)
            YAny.Null -> write(126)
            is YAny.Number -> {
                val n = value.value
                if (n == Math.rint(n) && kotlin.math.abs(n) <= 2_147_483_647.0 && !(n == 0.0 && 1.0 / n < 0)) {
                    write(125)
                    writeVarInt(n.toLong())
                } else if (n.toFloat().toDouble() == n) {
                    write(124)
                    val bits = n.toFloat().toRawBits()
                    for (shift in 24 downTo 0 step 8) write(bits ushr shift and 0xFF)
                } else {
                    write(123)
                    val bits = n.toRawBits()
                    for (shift in 56 downTo 0 step 8) write((bits ushr shift and 0xFF).toInt())
                }
            }
            is YAny.BigInt -> {
                write(122)
                for (shift in 56 downTo 0 step 8) write((value.value ushr shift and 0xFF).toInt())
            }
            is YAny.Bool -> write(if (value.value) 120 else 121)
            is YAny.Str -> {
                write(119)
                writeVarString(value.value)
            }
            is YAny.Object -> {
                write(118)
                writeVarUint(value.pairs.size)
                for ((key, item) in value.pairs) {
                    writeVarString(key)
                    writeAny(item)
                }
            }
            is YAny.Array -> {
                write(117)
                writeVarUint(value.items.size)
                for (item in value.items) writeAny(item)
            }
            is YAny.Bytes -> {
                write(116)
                writeVarUint8Array(value.value)
            }
        }
    }

    companion object {
        fun utf8(s: String): ByteArray {
            var ascii = true
            for (c in s) if (c.code >= 0x80) { ascii = false; break }
            if (ascii) return s.toByteArray(Charsets.ISO_8859_1)
            val out = java.io.ByteArrayOutputStream(s.length * 3)
            var i = 0
            while (i < s.length) {
                var cp = s[i].code
                if (Character.isHighSurrogate(s[i]) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1])) {
                    cp = Character.toCodePoint(s[i], s[i + 1])
                    i++
                } else if (Character.isSurrogate(s[i])) {
                    cp = 0xFFFD
                }
                i++
                when {
                    cp < 0x80 -> out.write(cp)
                    cp < 0x800 -> { out.write(0xC0 or (cp shr 6)); out.write(0x80 or (cp and 0x3F)) }
                    cp < 0x10000 -> { out.write(0xE0 or (cp shr 12)); out.write(0x80 or (cp shr 6 and 0x3F)); out.write(0x80 or (cp and 0x3F)) }
                    else -> {
                        out.write(0xF0 or (cp shr 18)); out.write(0x80 or (cp shr 12 and 0x3F))
                        out.write(0x80 or (cp shr 6 and 0x3F)); out.write(0x80 or (cp and 0x3F))
                    }
                }
            }
            return out.toByteArray()
        }
    }
}

/** lib0's `decoding`. */
class YDecoder(private val bytes: ByteArray) {
    var position = 0
        private set

    val hasContent: Boolean get() = position < bytes.size

    fun readUint8(): Int {
        if (position >= bytes.size) throw YError.Malformed("unexpected end")
        return bytes[position++].toInt() and 0xFF
    }

    fun readVarUintLong(): Long {
        var num = 0L
        var shift = 0
        while (true) {
            val byte = readUint8()
            num = num or ((byte and 0x7F).toLong() shl shift)
            shift += 7
            if (byte < 0x80) return num
            if (shift > 63) throw YError.Malformed("integer out of range")
        }
    }

    fun readVarUint(): Int {
        val value = readVarUintLong()
        if (value > Int.MAX_VALUE) throw YError.Malformed("integer out of range")
        return value.toInt()
    }

    fun readVarInt(): Long {
        var byte = readUint8()
        var num = (byte and 0x3F).toLong()
        var shift = 6
        val negative = byte and 0x40 != 0
        if (byte and 0x80 == 0) return if (negative) -num else num
        while (true) {
            byte = readUint8()
            num = num or ((byte and 0x7F).toLong() shl shift)
            shift += 7
            if (byte < 0x80) return if (negative) -num else num
            if (shift > 63) throw YError.Malformed("integer out of range")
        }
    }

    fun readBytes(count: Int): ByteArray {
        if (count < 0 || position + count > bytes.size) throw YError.Malformed("unexpected end")
        val out = bytes.copyOfRange(position, position + count)
        position += count
        return out
    }

    fun readVarUint8Array(): ByteArray = readBytes(readVarUint())

    fun readVarString(): String {
        val count = readVarUint()
        if (count < 0 || position + count > bytes.size) throw YError.Malformed("unexpected end")
        val out = String(bytes, position, count, Charsets.UTF_8)
        position += count
        return out
    }

    private fun readBigEndian(count: Int): Long {
        var raw = 0L
        for (byte in readBytes(count)) raw = (raw shl 8) or (byte.toLong() and 0xFF)
        return raw
    }

    fun readAny(): YAny = when (readUint8()) {
        127 -> YAny.Undefined
        126 -> YAny.Null
        125 -> YAny.Number(readVarInt().toDouble())
        124 -> YAny.Number(Float.fromBits(readBigEndian(4).toInt()).toDouble())
        123 -> YAny.Number(Double.fromBits(readBigEndian(8)))
        122 -> YAny.BigInt(readBigEndian(8))
        121 -> YAny.Bool(false)
        120 -> YAny.Bool(true)
        119 -> YAny.Str(readVarString())
        118 -> {
            val count = readVarUint()
            val pairs = ArrayList<Pair<String, YAny>>(minOf(count, 1024))
            repeat(count) {
                val key = readVarString()
                pairs += key to readAny()
            }
            YAny.Object(pairs)
        }
        117 -> {
            val count = readVarUint()
            val items = ArrayList<YAny>(minOf(count, 1024))
            repeat(count) { items += readAny() }
            YAny.Array(items)
        }
        116 -> YAny.Bytes(readVarUint8Array())
        else -> YAny.Undefined
    }
}
