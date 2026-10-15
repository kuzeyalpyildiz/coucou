package com.coucou.android

import com.coucou.android.core.QuestionSendGate
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class QuestionSendGateTest {
    @Test fun explicitConfirmationCanBeConsumedOnlyOnce() {
        val gate = QuestionSendGate()
        val token = gate.begin("question-one")
        assertTrue(gate.consume(token, "question-one"))
        assertFalse(gate.consume(token, "question-one"))
    }

    @Test fun dismissingNeverLetsALateConfirmationSend() {
        val gate = QuestionSendGate()
        val token = gate.begin("question-one")
        assertTrue(gate.cancel())
        assertFalse(gate.consume(token, "question-one"))
        assertFalse(gate.cancel())
    }

    @Test fun anOldCallbackCannotConsumeANewerQuestion() {
        val gate = QuestionSendGate()
        val old = gate.begin("question-one")
        gate.cancel()
        val current = gate.begin("question-two")
        assertFalse(gate.consume(old, "question-one"))
        assertTrue(gate.consume(current, "question-two"))
    }

    @Test fun aReplacedOrMissingQuestionCannotBeAnswered() {
        val gate = QuestionSendGate()
        assertFalse(gate.consume(gate.begin("question-one"), "question-two"))
        assertFalse(gate.consume(gate.begin("question-one"), null))
    }
}
