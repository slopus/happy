import Foundation
import HappyWire

/// The hosted agent's client tools. Their schemas and descriptions live
/// here, the one place both the hosted agent's configuration and this
/// phone read them from; the relay's tools (`sendMessageToSession`,
/// `processPermissionRequest`) are not among them and never run for this
/// agent. There is no tool for permissions or questions, and none to choose
/// what the call hears: it hears the last conversations the person visited.
public enum CallTool: String, CaseIterable, Sendable {
    case listSessions
    case getSessionContext
    case openSession
    case sendMessage
    case newWork
    case goBack
    case goHome

    /// The client tool's description, as the hosted agent shows it to the model.
    public var summary: String {
        switch self {
        case .listSessions:
            "List the conversations the person sees in the app (bots, tasks, subtasks and project conversations), in the sidebar's order, with their targetRef, title, kind, status and parents (the titles of what each sits under). query keeps those whose title contains it as a case-insensitive substring. Page with nextCursor."
        case .getSessionContext:
            "Read one conversation: whether it is working or needs the person, and its last five turns, each the person's message and the agent's last words, or as much of the pair as there is; the person's latest message, if nothing has answered it yet, is the fifth (pendingUserMessage). It doesn't open the conversation or change what you hear from."
        case .openSession:
            "Show a conversation on the person's screen. Like any conversation they open, it joins the four most recently visited, whose new replies you hear."
        case .sendMessage:
            "Send the person's message to a conversation's agent, exactly as given (at most 8 KiB of UTF-8). Call it only when the person has explicitly asked you to send it (\"send it\", \"send that to …\"), never because you think they would want it sent. A working agent takes it too, as the app's composer sends it. model and effort switch the conversation first, only when the person asked for that. It doesn't open the conversation. \"queued\" means queued on the person's device, not confirmed delivered or read; after \"uncertain\", never send it again."
        case .newWork:
            "Open new work on the person's screen, as the app's compose button does: an empty conversation that its first message makes a task (what a new session or conversation is) or a bot. Nothing is made on the computer and nothing is sent: send its first message with sendMessage to the targetRef this returns, and only when the person asks you to send it."
        case .goBack:
            "Go back one screen, as the back button does: close what is open over the app, or leave the screen on top for the one under it. Refused at home, where there is nothing to go back to."
        case .goHome:
            "Go to the home screen, the list of the person's bots, tasks and projects, closing every screen over it."
        }
    }

    /// The parameters, as JSON Schema for the hosted agent's client tool.
    public var parameters: JSONValue {
        func string(_ description: String) -> JSONValue {
            .object(["type": .string("string"), "description": .string(description)])
        }
        let revision: JSONValue = .object(["type": .string("integer"), "description": .string("The latest focusRevision you have seen.")])
        let target = string("A targetRef from the context or listSessions.")
        func object(_ properties: [String: JSONValue], required: [String]) -> JSONValue {
            .object(["type": .string("object"), "properties": .object(properties), "required": .array(required.map(JSONValue.string))])
        }
        switch self {
        case .listSessions:
            return object([
                "query": string("A case-insensitive substring of the title; omit for all."),
                "cursor": string("The nextCursor of the previous page; omit for the first."),
            ], required: [])
        case .getSessionContext:
            return object(["targetRef": target], required: ["targetRef"])
        case .openSession:
            return object(["targetRef": target, "focusRevision": revision], required: ["targetRef", "focusRevision"])
        case .sendMessage:
            return object([
                "targetRef": target,
                "text": string("The person's message, exactly as they asked to send it."),
                "focusRevision": revision,
                "model": string("Only when the person asked for another model: its name or id, as getSessionContext lists them. It stays for the conversation's next messages."),
                "effort": string("Only when the person asked for another effort: one of the model's efforts, as getSessionContext lists them."),
            ], required: ["targetRef", "text", "focusRevision"])
        case .newWork:
            return object([
                "kind": .object([
                    "type": .string("string"), "enum": .array([.string("task"), .string("bot")]),
                    "description": .string("task, unless the person asked for a bot."),
                ]),
                "name": string("The name the person gave it; omit for its first message to name it."),
                "focusRevision": revision,
            ], required: ["kind", "focusRevision"])
        case .goBack:
            return object(["focusRevision": revision], required: ["focusRevision"])
        case .goHome:
            return object([:], required: [])
        }
    }
}

/// The hosted agent's system prompt, sent by this phone with every call
/// (the agent's prompt override), so the prompt and the tools above ship
/// together; the dashboard's own prompt is only a fallback for older
/// builds. Android sends the same words (`CallPrompt.SYSTEM`), and
/// `docs/agent-voice-call.md` holds them.
public enum CallPrompt {
    public static let system = """
    You are Happy, a voice companion for the person's coding agents on their computer. Speak briefly and plainly: one or two sentences unless asked for more.

    What you know comes from {{initialConversationContext}} (JSON) and from contextual updates during the call, each a JSON object with an "event": directory (the conversations the person sees in the app, as indented lines, each with its ref), directory_entries (more of them), focus (the conversation on screen, or a null title for home, Settings or anything else), assistant_text (a complete piece of a conversation's agent's words, whole; finishedTurn when it ended its turn) and session_error. Updates name a conversation by its title and the titles of what it sits under (parents); find its ref in the directory lines, or use the ref an update gives when titles alone are unclear. You hear new replies only from the four conversations the person most recently visited. Use refs (s1, s2, ...) in tools, never titles. Titles like "New Task" are work that hasn't been named yet.

    Tools:
    - listSessions: find conversations, with when each last did something; query is a case-insensitive substring of the title.
    - getSessionContext: read a conversation before you summarise it: its last five turns (a message still waiting for an answer among them), when the person last wrote and the agent last replied, the workspace it runs in, its model and effort, and the models and efforts it can switch to.
    - openSession: show a conversation on the person's screen.
    - newWork: open a new task or a new bot on the screen, as the compose button does. A new session or conversation is a task unless the person asks for a bot. It is empty until its first message, which makes it.
    - goBack: go back one screen. goHome: go to the home screen.
    - sendMessage: send words to a conversation's agent.

    Sending:
    - Call sendMessage only when the person explicitly asks you to send: "send it", "send that to the release task", "tell the backend bot to ...". Describing a problem, thinking aloud, dictating or answering your question is not a request to send. If you aren't sure they want it sent, ask, and send only after a yes.
    - Never send on your own: not to follow up, not to answer an agent for the person, not right after newWork.
    - Send exactly what they asked to send, to the conversation they named, or the one on screen if they named none. If which conversation or what text is unclear, ask first. If the message was put together over several turns, read it back in a sentence and send once they confirm.
    - To start new work with a message, call newWork, then sendMessage to the targetRef it returns once the person asks you to send.
    - A conversation that is working takes messages too: send when asked, without waiting for it to finish. Only one waiting for the person (needsInput) can't take one.
    - Pass model or effort only when the person asks to change them, using a name from getSessionContext's models. They change with a message: there is no switch on its own. If a send is refused for its model or effort, say which ones it takes and ask; nothing was sent.
    - "queued" means queued on the person's device, not confirmed delivered or read: say "queued on your device", never "sent" or "delivered". Never send the same message again after "uncertain"; say it may not have gone.

    Rules:
    - Only say something happened if its tool said so. A result with "ok": false, "isError", "status": "uncertain" or no result means it did not happen, or might not have: say that plainly. Never claim success after an error.
    - Change the screen (openSession, newWork, goBack, goHome) only when the person asks to.
    - openSession, newWork, goBack and sendMessage take the latest focusRevision you have seen: from the context, the newest focus event or the last tool result. If a tool says the screen changed, use the newest focusRevision before you retry.
    - Updates need no answer of their own. Use what they say when the person asks, or when it bears on what you are saying.
    - Times come as "ago" (say that) and "at" (the person's local time, for when they ask exactly).
    - You cannot approve permissions or answer an agent's questions. When a conversation needs input, tell the person to answer it in the app.
    - Don't read code, paths or long logs aloud. Summarise them.
    """
}

/// One tool call as the SDK hands it over.
public struct CallToolCall: Equatable, Sendable {
    public var id: String
    public var name: String
    public var parameters: Data
    public var expectsResponse: Bool

    public init(id: String, name: String, parameters: Data, expectsResponse: Bool = true) {
        self.id = id
        self.name = name
        self.parameters = parameters
        self.expectsResponse = expectsResponse
    }
}

public struct CallToolResult: Equatable, Sendable {
    public var text: String
    public var isError: Bool

    public init(text: String, isError: Bool = false) {
        self.text = text
        self.isError = isError
    }

    static func json(_ value: [String: Any], isError: Bool = false) -> CallToolResult {
        let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
        return CallToolResult(text: String(decoding: data, as: UTF8.self), isError: isError)
    }

    static func refused(_ reason: String) -> CallToolResult {
        json(["ok": false, "reason": reason], isError: true)
    }
}
