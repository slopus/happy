package com.slopus.happy.crypto

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Byte-for-byte agreement with happy-app. Every expected value here was
 * computed by happy-app's own TypeScript (see tools/testvectors/generate.mjs),
 * with randomness replayed from the vector so encryption is deterministic.
 */
class TsVectorsTest {

    @Test
    fun base64MatchesBase64Ts() {
        for (v in TsVectors.group("base64")) {
            val data = v.hex("dataHex")
            assertEquals(v.str("standard"), encodeBase64(data))
            assertEquals(v.str("url"), encodeBase64(data, Base64Variant.Url))
            assertArrayEquals(data, decodeBase64(v.str("standard")))
            assertArrayEquals(data, decodeBase64(v.str("url"), Base64Variant.Url))
        }
    }

    @Test
    fun keyTreeMatchesDeriveKeyTs() {
        for (v in TsVectors.group("deriveKey")) {
            val seed = v.hex("seedHex")
            val usage = v.str("usage")
            val path = v.strings("path")
            val root = deriveSecretKeyTreeRoot(seed, usage)
            assertEquals(v.str("rootKeyHex"), root.key.toHex())
            assertEquals(v.str("rootChainCodeHex"), root.chainCode.toHex())
            var chainCode = root.chainCode
            v.getValue("children").jsonArray.forEachIndexed { i, child ->
                val state = deriveSecretKeyTreeChild(chainCode, path[i])
                assertEquals(child.jsonObject.str("keyHex"), state.key.toHex())
                assertEquals(child.jsonObject.str("chainCodeHex"), state.chainCode.toHex())
                chainCode = state.chainCode
            }
            assertEquals(v.str("keyHex"), deriveKey(seed, usage, path).toHex())
        }
    }

    @Test
    fun ed25519MatchesLibsodium() {
        for (v in TsVectors.group("sign")) {
            val keyPair = Sodium.signSeedKeypair(v.hex("seedHex"))
            assertEquals(v.str("publicKeyHex"), keyPair.publicKey.toHex())
            assertEquals(v.str("secretKeyHex"), keyPair.secretKey.toHex())
            val signature = Sodium.signDetached(v.hex("messageHex"), keyPair.secretKey)
            assertEquals(v.str("signatureHex"), signature.toHex())
            assertTrue(Sodium.signVerifyDetached(signature, v.hex("messageHex"), keyPair.publicKey))
        }
    }

    @Test
    fun boxKeysMatchLibsodium() {
        for (v in TsVectors.group("boxSeedKeypair")) {
            val keyPair = Sodium.boxSeedKeypair(v.hex("seedHex"))
            assertEquals(v.str("publicKeyHex"), keyPair.publicKey.toHex())
            assertEquals(v.str("secretKeyHex"), keyPair.secretKey.toHex())
        }
        for (v in TsVectors.group("boxBeforeNm")) {
            val shared = Sodium.boxBeforeNm(v.hex("publicKeyHex"), v.hex("secretKeyHex"))
            assertEquals(v.str("sharedKeyHex"), shared?.toHex())
        }
    }

    @Test
    fun secretboxMatchesLibsodium() {
        for (v in TsVectors.group("secretbox")) {
            val ciphertext = Sodium.secretboxEasy(v.hex("messageHex"), v.hex("nonceHex"), v.hex("keyHex"))
            assertEquals(v.str("ciphertextHex"), ciphertext.toHex())
            val opened = Sodium.secretboxOpenEasy(ciphertext, v.hex("nonceHex"), v.hex("keyHex"))
            assertEquals(v.str("messageHex"), opened?.toHex())
        }
    }

    @Test
    fun encryptBoxMatchesLibsodiumTs() {
        for (v in TsVectors.group("encryptBox")) {
            val random = ScriptedRandom(v.hex("ephemeralSecretKeyHex"), v.hex("nonceHex"))
            val bundle = encryptBox(v.hex("dataHex"), v.hex("recipientPublicKeyHex"), random)
            random.assertDrained()
            assertEquals(v.str("bundleHex"), bundle.toHex())
            assertEquals(v.str("dataHex"), decryptBox(v.hex("bundleHex"), v.hex("recipientSecretKeyHex"))?.toHex())
        }
    }

    @Test
    fun encryptBlobMatchesBlobTs() {
        for (v in TsVectors.group("encryptBlob")) {
            val random = ScriptedRandom(v.hex("nonceHex"))
            val bundle = encryptBlob(v.hex("dataHex"), v.hex("keyHex"), random)
            random.assertDrained()
            assertEquals(v.str("bundleHex"), bundle.toHex())
            assertEquals(v.str("dataHex"), decryptBlob(v.hex("bundleHex"), v.hex("keyHex"))?.toHex())
        }
    }

    @Test
    fun dataKeyCipherMatchesAes256EncryptionTs() {
        for (v in TsVectors.group("aes256")) {
            val payload = Json.parseToJsonElement(v.str("json"))
            val random = ScriptedRandom(v.hex("ivHex"))
            val sealed = DataKeyCipher(v.hex("keyHex"), random).encryptToBase64(payload)
            random.assertDrained()
            assertEquals(v.str("bundleBase64"), sealed)
            assertEquals(payload, DataKeyCipher(v.hex("keyHex")).decryptFromBase64(v.str("bundleBase64")))
        }
    }

    @Test
    fun secretBoxCipherMatchesSecretBoxEncryptionTs() {
        for (v in TsVectors.group("secretBoxJson")) {
            val payload = Json.parseToJsonElement(v.str("json"))
            val random = ScriptedRandom(v.hex("nonceHex"))
            val sealed = SecretBoxCipher(v.hex("secretHex"), random).encryptToBase64(payload)
            random.assertDrained()
            assertEquals(v.str("bundleBase64"), sealed)
            assertEquals(payload, SecretBoxCipher(v.hex("secretHex")).decryptFromBase64(v.str("bundleBase64")))
        }
    }

    @Test
    fun accountEncryptionMatchesEncryptionCreate() {
        for (v in TsVectors.group("accountEncryption")) {
            val random = ScriptedRandom(v.hex("ephemeralSecretKeyHex"), v.hex("nonceHex"))
            val account = AccountEncryption.create(v.hex("masterSecretHex"), random)
            assertEquals(v.str("contentPublicKeyHex"), account.contentPublicKey.toHex())
            assertEquals(v.str("anonId"), account.anonId)
            assertEquals(v.str("providerAccountKeyHex"), account.providerAccountKey.toHex())

            val wrapped = encodeBase64(account.encryptDataEncryptionKey(v.hex("dataKeyHex")))
            random.assertDrained()
            assertEquals(v.str("wrappedDataKeyBase64"), wrapped)
            assertEquals(v.str("dataKeyHex"), account.decryptDataEncryptionKey(v.str("wrappedDataKeyBase64"))?.toHex())
            assertEquals(v.str("blobKeyHex"), AccountEncryption.blobKeyForDataKey(v.hex("dataKeyHex")).toHex())
            assertEquals(v.str("masterBlobKeyHex"), account.masterBlobKey.toHex())
        }
    }

    @Test
    fun authChallengeMatchesAuthChallengeTs() {
        for (v in TsVectors.group("authChallenge")) {
            val random = ScriptedRandom(v.hex("challengeHex"))
            val challenge = AuthChallenge.create(v.hex("secretHex"), random)
            random.assertDrained()
            assertEquals(v.str("challengeHex"), challenge.challenge.toHex())
            assertEquals(v.str("signatureHex"), challenge.signature.toHex())
            assertEquals(v.str("publicKeyHex"), challenge.publicKey.toHex())
            val body = v.getValue("requestBody").jsonObject
            assertEquals(body.str("challenge"), encodeBase64(challenge.challenge))
            assertEquals(body.str("signature"), encodeBase64(challenge.signature))
            assertEquals(body.str("publicKey"), encodeBase64(challenge.publicKey))
        }
    }

    @Test
    fun accountLinkKeysMatchAuthQrStartTs() {
        for (v in TsVectors.group("accountLink")) {
            val random = ScriptedRandom(v.hex("seedHex"))
            val keyPair = AccountLink.generateKeyPair(random)
            random.assertDrained()
            assertEquals(v.str("publicKeyHex"), keyPair.publicKey.toHex())
            assertEquals(v.str("secretKeyHex"), keyPair.secretKey.toHex())
            assertEquals(v.str("url"), AccountLink.linkUrl(keyPair.publicKey))
            assertEquals(v.str("publicKeyHex"), AccountLink.parseLinkUrl(v.str("url"))?.toHex())
        }
    }

    @Test
    fun secretKeyBackupMatchesSecretKeyBackupTs() {
        for (v in TsVectors.group("secretKeyBackup")) {
            assertEquals(v.str("formatted"), SecretKeyBackup.format(v.str("base64url")))
            assertEquals(v.str("base64url"), SecretKeyBackup.parse(v.str("formatted")))
            assertEquals(v.str("normalizedMessy"), SecretKeyBackup.normalize(v.str("messy")))
        }
    }
}
