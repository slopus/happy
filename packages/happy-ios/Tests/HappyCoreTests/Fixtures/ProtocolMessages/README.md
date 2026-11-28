# Protocol message fixtures

Conversation messages as a Happy Agent server sends them, for checking a
client's message validation. Every client that validates messages at ingest
(desktop, iOS, Android) can run the same files.

The schema is the one `@slopus/happy-agent-client` 0.0.184 defines: its
published TypeBox schemas for blocks, presentations, failures and metadata, and
its `Message` TypeScript types for the envelope and the text, image, reasoning
and tool-call blocks. Desktop's composition of them is
`packages/happy-desktop-state/src/happyAgentConnection/messageValidate.ts`.

Five departures from that schema. Two keep an older client reading a newer
server: a tool-call presentation of a type the client does not know is dropped
rather than failing its message, and a question's `header` may be empty. The
third keeps old history readable: a user message's `mode` may be `null`, as
Happy Agent sends it for a message stored before modes were
(`ApiMessageProjection.ts`, `mode: message.mode ?? null`), although the
published `UserMessage` type declares `mode: MessageMode`. `mode` must still
be present. The fourth keeps old Happy Cloud history readable: a tool call
may carry a well-formed `review` without `elevated`, and its elevation is
then unknown. `elevated` without `review`, or a malformed `review`, still
fails. The fifth also keeps old Happy Cloud history readable: a tool call's
`arguments` and `result` may be any JSON value, not only an object (old
Cloud history stores results such as `"Message delivered."` as they were),
and a client reads them as opaque JSON.

## Layout

- `valid/` — messages that must pass. Together they cover every role (user,
  agent, system, service), every block type (text, image, file,
  tool_call_request, reasoning, tool_call, configuration, compaction, and the
  retired ui/action/quick_replies), every tool presentation type, a
  presentation type no client knows, and both halves of tool-call review
  metadata.
- `invalid/` — messages that must fail. A client shows each one as a
  placeholder in its place and keeps drawing the messages around it.

## File format

Each file is one JSON object:

```json
{
    "description": "What this case is and why it exists.",
    "invalidAt": ["/content/1/presentation/answers"],
    "message": {}
}
```

- `message` is the message exactly as it arrives in history, a
  `message.created` or `message.updated` event, or an HTTP reply.
- `invalidAt` appears only in `invalid/`. Each entry is a JSON pointer into
  `message` where it breaks the schema. A validator must report a failure at
  or under every listed pointer; it may report more.

## Notable cases

- `invalid/cluster-cancelled-question.json` is Happy Cloud's card for a
  question the person answered by replying in chat (hc-agent
  `history.rs`, `resume_question_after_human_message`): question ID
  `"reviewer"`, an empty `header`, `status: "canceled"` and `answers: null`.
  It fails on `answers`; the empty header alone is allowed.
  Read as an answered question, it crashed desktop with "Cannot read
  properties of null (reading 'reviewer')".
- `valid/agent-presentation-unknown-type.json` is what a newer server's tool
  presentation looks like to an older client. A presentation whose `type`
  the client does not know is read as no presentation: the client shows the
  plain tool call and logs it once. A presentation of a known type with a bad
  shape, such as the card above, still fails the whole message.
- `valid/user-legacy-null-mode.json` is such a user message with `mode: null`;
  `invalid/user-missing-mode.json`, with no `mode` at all, still fails.
- `valid/agent-tool-review-without-elevated.json` is a reviewed Happy Cloud
  call from before its fix, with `review` and no `elevated`;
  `invalid/elevated-without-review.json` and `invalid/review-malformed.json`
  still fail.
- `valid/agent-tool-result-string.json` is old Happy Cloud history with
  string results; `valid/agent-tool-data-not-object.json` covers string,
  array, number and null `arguments` and `result`.
- A question's `header` may be empty: clients do not enforce the published
  schema's `minLength: 1` on it.
