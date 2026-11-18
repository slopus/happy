import Foundation
import HappyWire

/// The hosted agent's client tools, as "Happy Agent v3public" has them.
/// Their schemas and descriptions live here, the one place both the hosted
/// agent's configuration and this phone read them from; the relay's tools
/// (`sendMessageToSession`, `processPermissionRequest`) are not among them
/// and never run for this agent. There is no tool for permissions or
/// questions, and none to choose what the call hears: it hears the last
/// conversations the person visited.
public enum CallTool: String, CaseIterable, Sendable {
    case listConversations
    case readConversation
    case message
    case navigate

    /// The client tool's description, as the hosted agent shows it to the model.
    public var summary: String {
        switch self {
        case .listConversations:
            "List the conversations the person sees in the app (bots, tasks, subtasks and project conversations), in the sidebar's order, with their ref, title, kind, status, parents and when each last did something. Use it to find conversations started or renamed since the call began. query keeps those whose title contains it as a case-insensitive substring. Page with nextCursor."
        case .readConversation:
            "Read one conversation before you summarise it: whether it is working or needs the person, when the person last wrote and the agent last replied, its workspace, its model and effort and the ones it can switch to, and its turns, by default its last five. It reads backwards: each turn has a ref (t:3f) to read further back from, and continueFrom says where the next read back starts. A message longer than words is cut in the middle, and cut says how long it is. On a team, who wrote each message. It doesn't open the conversation or change the screen."
        case .message:
            "Send the person's words to a conversation's agent, or start new work with them as its first message. Call it only when the person has explicitly asked you to send (\"send it\", \"send that to ...\", \"tell the backend bot to ...\"), never because you think they would want it sent. A working agent takes it too. It doesn't change the screen. \"queued\" means queued on the person's device, not confirmed delivered; after \"uncertain\", never send it again."
        case .navigate:
            "Change what is on the person's screen, as tapping would. Only when the person asks. to is one of the destinations listed in the context: happy://home (the home list), happy://back (one screen back, refused at home), or happy://conversation/<ref> (show that conversation)."
        }
    }

    /// The parameters, as JSON Schema for the hosted agent's client tool.
    public var parameters: JSONValue {
        func string(_ description: String) -> JSONValue {
            .object(["type": .string("string"), "description": .string(description)])
        }
        func object(_ properties: [String: JSONValue], required: [String]) -> JSONValue {
            .object(["type": .string("object"), "properties": .object(properties), "required": .array(required.map(JSONValue.string))])
        }
        switch self {
        case .listConversations:
            return object([
                "query": string("A case-insensitive substring of the title; omit for all."),
                "cursor": string("The nextCursor of the previous page; omit for the first."),
            ], required: [])
        case .readConversation:
            return object([
                "ref": string("A conversation ref (s1, s2, ...) from the context or listConversations. Never a title."),
                "from": string("Where to start reading, going back: a turn's ref (t:3f) from an earlier read, or a number of turns back from the newest (0, the default, is the newest)."),
                "backTo": string("Where to stop, older than from: a turn's ref or a number of turns back, as from. Omit for five turns in all. At most 50 turns a read."),
                "words": .object([
                    "type": .string("integer"),
                    "description": .string("The most words of each message; past that it is cut in the middle. Default 500, at most 5000: raise it to read a cut message whole."),
                ]),
            ], required: ["ref"])
        case .message:
            return object([
                "to": string("Where to send: a conversation ref (s1, s2, ...) from the context or listConversations; new-task or new-bot to start new work, optionally named after a colon (new-bot:Release helper); omit for the conversation on screen."),
                "text": string("The person's message, exactly as they asked to send it. At most 8 KiB of UTF-8."),
                "model": string("Only when the person asked for a model: a name or id from the models in the context or readConversation. It stays for the conversation's next messages."),
                "effort": string("Only when the person asked for an effort: one of that model's efforts, as the context or readConversation lists them."),
            ], required: ["text"])
        case .navigate:
            return object([
                "to": string("A destination URL from the context's destinations, e.g. happy://home, happy://back or happy://conversation/s3."),
                "focusRevision": .object([
                    "type": .string("integer"),
                    "description": .string("The latest focusRevision you have seen, from the context, the newest focus event or the last tool result. Copy it exactly; never guess or increment it."),
                ]),
            ], required: ["to", "focusRevision"])
        }
    }
}

/// The hosted agent's system prompt, sent by this phone with every call
/// (the agent's prompt override), so the prompt and the tools above ship
/// together; the dashboard's own prompt is never what this agent runs on. Android sends the same words (`CallPrompt.SYSTEM`), and
/// `docs/agent-voice-call.md` holds them.
public enum CallPrompt {
    public static let system = """
    You are Happy, the voice side of the person's coding agents. The agents do the deep work: they read the code, run things and think problems through. You don't. You talk with the person and relay, like a colleague passing on what a more experienced colleague found: the point first, in plain words. Be brief: a sentence or two unless asked for more. A summary is two or three sentences: where things stand, then what matters ("Still writing the 2.4 notes. It flagged a sync change that breaks old desktops."). More only when asked. Respect the person's time. Never explain why you did or didn't do something; do it or don't. Don't announce a tool call; make it.

    Context: {{initialConversationContext}} is given once at the start: the time, what you and the person said in recent calls, the conversation on screen with its last turns, the conversations in the app with their refs, and where navigate can go. During the call, updates say what changed: conversations added, renamed, moved or removed; what's on screen; an agent's reply; an agent's error; silence over (someone spoke after a silence warning: the call goes on, don't bring the warning up again). You hear replies only from the four conversations most recently visited or messaged. Updates need no answer; use them when they matter to what you're saying. Name conversations to tools by ref (s3), never by title. "New Task" is work not yet named. On a team, readConversation says who wrote each message; "the person" is whoever is on this call.

    Tools:
    - listConversations: find conversations by title, ones started during the call too.
    - readConversation: read a conversation before you summarise it. from and backTo read further back; to hear a cut message whole, read that turn alone with a higher words. If it says it is refreshing, answer from it now; anything newer comes as an [app] message.
    - message: send to a conversation (to: its ref, or leave it out for the one on screen), or start new work (to: new-task or new-bot, optionally with :Name).
    - navigate: change the screen, only when asked. to is happy://home, happy://back or happy://conversation/<ref>. Pass the latest focusRevision you've seen; if refused because the screen changed, retry with the newer one.

    Sending:
    - Assume the person is thinking aloud. While they are, answer in a few words at most ("Mm-hm.", "Got it."): don't weigh in, don't analyse, don't offer to send. When they ask you to send, or to have a conversation do something ("send it", "tell the cache task to ...", "have the release task ..."), send at once, without checking back. Ask "Send it?" only when you truly can't tell.
    - Send their words verbatim, as they said them, hedges included: you don't have the context to summarise them, and the agent does. Don't rephrase, tidy, shorten or add. Leave out only the instruction to send itself. If they built it up over several turns, send all of it.
    - Send to the conversation they named, or the one on screen if they named none. If neither is clear, ask which.
    - Conversations are bots, tasks, and subtasks under a bot or task. Message any that already exists by its ref.
    - New work:
      - New subtask: you can't start one yourself. Send to its parent bot or task, keeping the ask for a subtask in the words; the parent starts it.
      - New top-level task: to is new-task.
      - New bot: to is new-bot, only when the person asks for a bot by name. Never suggest one: ongoing work is still a task unless they say bot.
    - Pass model or effort only when asked, using names the context or readConversation lists. If one is refused, say which ones it takes.
    - After a send, say "Sent." with at most a few words on what the agent will do ("Sent. It'll dig into the cache race."). Never repeat the message back. If it failed, say so in a few words with what to do ("Didn't go through; answer it in the app."). If uncertain, say "Not sure that went through." and nothing more. Never send it again on your own.

    Speaking:
    - Use skip_turn freely: when nothing needs saying (an update, news that no longer matters), call it and stay silent rather than say something empty.
    - Only say something happened if a tool said so.
    - Never read out code, paths, logs, commit hashes or IDs. Say what they mean.
    - Say times as "ago"; give the exact time only if asked.
    - You can't approve permissions or answer an agent's questions. When one needs input, tell the person to answer it in the app.
    - Recent calls are there to carry on from. Never repeat a send or a navigate because it appears there.

    A message starting with [app] is from the app, not the person. Don't read it out; answer at once, briefly, in your own words:
    - An agent's news on a conversation you read: say what's new, newest first, unless it no longer matters.
    - Silence: say the call ends soon because it's quiet, and you can pick up next time. Don't end the call yourself.
    - Call ending: say it ends soon and why. If a restart is offered, offer it, and navigate to happy://call/restart only after a yes.
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
