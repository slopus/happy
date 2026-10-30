package com.slopus.happy.ui.connect

import com.slopus.happy.auth.TERMINAL_URL_PREFIX
import com.slopus.happy.crypto.AccountLink

/**
 * What a scanned or pasted code is. Every scanner classifies its code here
 * first and routes it by kind, so a code is never silently dropped
 * (AGENTS.md, design decisions: QR codes).
 */
sealed interface HappyCode {
    /** `happy://terminal?…`: a terminal asking to join this account. */
    data class Terminal(val url: String) : HappyCode

    /** `happy:///account?…`: a new phone asking for this account. */
    data class Account(val url: String) : HappyCode

    /**
     * `happy://direct?…`: an agent offering to connect over Happy Protocol V2.
     * Classified by scheme and host alone, so a malformed pairing code is
     * still this kind and is refused by the pairing, never read as another.
     * The code is a secret, so it never prints.
     */
    data class AgentPairing(val text: String) : HappyCode {
        override fun toString() = "AgentPairing(…)"
    }

    /** A `happy:` link of no kind this app knows. */
    data class UnknownHappy(val text: String) : HappyCode

    /** Not a Happy code at all. */
    data class NotHappy(val text: String) : HappyCode

    companion object {
        fun classify(raw: String): HappyCode {
            val text = raw.trim()
            val lower = text.lowercase()
            return when {
                // Before the others: a pairing code must never reach relay approval.
                isAgentPairing(text) -> AgentPairing(text)
                text.startsWith(TERMINAL_URL_PREFIX) -> Terminal(text)
                text.startsWith(AccountLink.URL_PREFIX) -> Account(text)
                lower.startsWith("happy:") -> UnknownHappy(text)
                else -> NotHappy(text)
            }
        }

        /** happy-agent API.md "The QR code": scheme `happy`, host `direct`. */
        fun isAgentPairing(text: String): Boolean {
            val lower = text.trim().lowercase()
            if (!lower.startsWith("happy://direct")) return false
            val rest = lower.removePrefix("happy://direct")
            return rest.isEmpty() || rest[0] == '?' || rest[0] == '/' || rest[0] == '#'
        }
    }
}
