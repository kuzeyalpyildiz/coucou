package com.coucou.android.core

/** A confirmation callback may submit only the question sheet that opened it. */
class QuestionSendGate {
    private var generation = 0L
    private var active: Pair<Long, String>? = null

    fun begin(fingerprint: String): Long {
        val token = ++generation
        active = token to fingerprint
        return token
    }

    /** Dismissing the sheet invalidates callbacks, without answering the question. */
    fun cancel(): Boolean {
        val pending = active != null
        active = null
        return pending
    }

    fun consume(token: Long, currentFingerprint: String?): Boolean {
        val pending = active ?: return false
        if (pending.first != token) return false
        active = null
        return pending.second == currentFingerprint
    }
}
