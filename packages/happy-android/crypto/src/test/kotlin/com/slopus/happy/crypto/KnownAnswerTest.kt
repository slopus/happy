package com.slopus.happy.crypto

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

/** Published test vectors, independent of happy-app. */
class KnownAnswerTest {

    @Test
    fun hmacSha512Rfc4231() {
        // The same three cases as happy-app's hmac_sha512.appspec.ts.
        assertEquals(
            "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737",
            hmacSha512("Jefe".encodeToByteArray(), decodeHex("7768617420646f2079612077616e7420666f72206e6f7468696e673f")).toHex(),
        )
        assertEquals(
            "87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cdedaa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854",
            hmacSha512(decodeHex("0b".repeat(20)), decodeHex("4869205468657265")).toHex(),
        )
        assertEquals(
            "fa73b0089d56a284efb0f0756c890be9b1b5dbdd8ee81a3655f83e33b2279d39bf3e848279a722c806b485a47e67c807b946a337bee8942674278859e13292fb",
            hmacSha512(decodeHex("aa".repeat(20)), decodeHex("dd".repeat(50))).toHex(),
        )
    }

    @Test
    fun deriveKeyAppspecVectors() {
        // happy-app's deriveKey.appspec.ts
        val seed = "test seed".encodeToByteArray()
        val root = deriveSecretKeyTreeRoot(seed, "test usage")
        assertEquals("E6E55652456F9FE47D6FF46CA3614E85B499F77E7B340FBBB1553307CEDC1E74", encodeHex(root.key))
        assertEquals("81ECFD529E8EF95DD5C06CFE169158CF02B7C09A33746C527B4BD4D740B9CC5A", encodeHex(root.chainCode))
        val child = deriveSecretKeyTreeChild(root.chainCode, "child1")
        assertEquals("D5EAE039FB9143E9433BB1ADC104C2FF5D7FA6751E680B4B1CBC7ADF1AF65BF3", encodeHex(child.key))
        assertEquals("8AA339189BAB38B51DD8770B1498682BCB03E42240E273041ACC7E3DF62FE868", encodeHex(child.chainCode))
        val grandchild = deriveSecretKeyTreeChild(child.chainCode, "child2")
        assertEquals("1011C097D2105D27362B987A631496BBF68B836124D1D072E9D1613C6028CF75", encodeHex(grandchild.key))
        assertEquals("BE98EF894B1C62B8253B480DD415B6EB707028362F2FCECF2CB3871DB8B007F1", encodeHex(grandchild.chainCode))
        assertEquals(encodeHex(grandchild.key), encodeHex(deriveKey(seed, "test usage", listOf("child1", "child2"))))
    }

    @Test
    fun ed25519Rfc8032TestOne() {
        val keyPair = Sodium.signSeedKeypair(decodeHex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"))
        assertEquals("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", keyPair.publicKey.toHex())
        assertEquals(
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
            Sodium.signDetached(ByteArray(0), keyPair.secretKey).toHex(),
        )
    }

    @Test
    fun x25519Rfc7748AndNaclFirstKey() {
        val aliceSecret = decodeHex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
        val bobSecret = decodeHex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb")
        val alicePublic = Sodium.scalarMultBase(aliceSecret)
        val bobPublic = Sodium.scalarMultBase(bobSecret)
        assertEquals("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a", alicePublic.toHex())
        assertEquals("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f", bobPublic.toHex())
        assertEquals("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742", Sodium.scalarMult(aliceSecret, bobPublic)?.toHex())
        // NaCl's crypto_box "firstkey"
        assertEquals("1b27556473e985d462cd51197a9a46c76009549eac6474f206c4ee0844f68389", Sodium.boxBeforeNm(bobPublic, aliceSecret)?.toHex())
        assertArrayEquals(Sodium.boxBeforeNm(bobPublic, aliceSecret), Sodium.boxBeforeNm(alicePublic, bobSecret))
    }

    @Test
    fun base64AppspecVectors() {
        // happy-app's base64.appspec.ts
        assertEquals("", encodeBase64(ByteArray(0)))
        assertEquals("SA==", encodeBase64(byteArrayOf(72)))
        assertEquals("SGVsbG8sIFdvcmxkIQ==", encodeBase64("Hello, World!".encodeToByteArray()))
        assertEquals("AQIDBA==", encodeBase64(byteArrayOf(1, 2, 3, 4)))
        assertEquals("/////w==", encodeBase64(ByteArray(4) { -1 }))
        assertEquals("Pj8-Pw", encodeBase64(byteArrayOf(62, 63, 62, 63), Base64Variant.Url))
        assertEquals("_P3-_w", encodeBase64(byteArrayOf(-4, -3, -2, -1), Base64Variant.Url))
        assertEquals("AQIDBAU", encodeBase64(byteArrayOf(1, 2, 3, 4, 5), Base64Variant.Url))
        val key = intArrayOf(
            25, 98, 84, 190, 50, 194, 51, 115, 197, 46, 112, 77, 155, 180, 158, 245,
            129, 17, 92, 203, 118, 244, 18, 70, 144, 34, 83, 84, 123, 21, 151, 61,
        ).map { it.toByte() }.toByteArray()
        assertEquals("GWJUvjLCM3PFLnBNm7Se9YERXMt29BJGkCJTVHsVlz0=", encodeBase64(key))
        assertEquals("GWJUvjLCM3PFLnBNm7Se9YERXMt29BJGkCJTVHsVlz0", encodeBase64(key, Base64Variant.Url))
        assertArrayEquals(key, decodeBase64("GWJUvjLCM3PFLnBNm7Se9YERXMt29BJGkCJTVHsVlz0", Base64Variant.Url))
    }
}
