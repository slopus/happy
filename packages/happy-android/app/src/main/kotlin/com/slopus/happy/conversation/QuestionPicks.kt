package com.slopus.happy.conversation

// A waiting question's ticks, as the screen keeps them until Submit or a
// typed answer sends them (iOS 7f6355041 `ChatItem.Ask`; desktop's
// `toggleValue`, `pendingQuestionAnswer`).

/** Every prompt has a pick: Submit may go. */
fun Question.complete(picked: Map<String, List<String>>): Boolean =
    prompts.isNotEmpty() && prompts.all { !picked[it.id].isNullOrEmpty() }

/** A pick of [label] on prompt [promptId]: one alone, or one more of many, taken back when picked again. */
fun Question.picking(picked: Map<String, List<String>>, promptId: String, label: String): Map<String, List<String>> {
    val current = picked[promptId].orEmpty()
    val many = prompts.firstOrNull { it.id == promptId }?.multiSelect ?: false
    val next = when {
        label in current -> current - label
        many -> current + label
        else -> listOf(label)
    }
    return picked + (promptId to next)
}

/**
 * What a message typed in the composer answers: each prompt its picks,
 * else the [typed] words; [TypedAnswer.textUsed] when any prompt took them.
 */
fun Question.answers(picked: Map<String, List<String>>, typed: String): TypedAnswer {
    var textUsed = false
    val answers = prompts.associate { prompt ->
        val chosen = picked[prompt.id].orEmpty()
        if (chosen.isEmpty()) {
            textUsed = true
            prompt.id to listOf(typed)
        } else {
            prompt.id to chosen
        }
    }
    return TypedAnswer(answers, textUsed)
}

data class TypedAnswer(val answers: Map<String, List<String>>, val textUsed: Boolean)
