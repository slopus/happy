import Foundation

/// CommandView with `syntaxHighlighting`, which only BashViewFull turns on:
/// SyntaxText over the command as bash and over stdout and stderr as a
/// shell session, through the diff view's tokenizer and the account's
/// cache (`service`). Call it off the main thread: tokenizing can take up
/// to `DiffSyntax.revealMilliseconds`.
public enum TerminalSyntax {
    /// `commandLanguage={command ? 'bash' : null}`: the activity label shown
    /// in place of a command stays plain.
    public static func commandLanguage(prompt: Bool) -> String? {
        prompt ? "bash" : nil
    }

    public static let outputLanguage = "shell-session"

    /// SyntaxText's spans for `code`. A cached result is used at once; a
    /// missing one is tokenized here until `deadline` (useSyntaxRequests'
    /// reveal gate), or after it left plain and tokenized in the
    /// background into the cache, for the next plan. Nil draws `code`
    /// plain: no language, past the limits, or nothing to colour.
    public static func spans(
        _ code: String,
        language: String?,
        until deadline: ContinuousClock.Instant,
        service: DiffSyntaxService
    ) -> [(text: String, kind: DiffSpanKind)]? {
        guard let plan = DiffSyntaxPlan.planCode(code, language: language) else { return nil }
        if let cached = service.peek(plan.key) {
            return DiffSyntaxPlan.codeSpans(plan.input, outcome: cached)
        }
        guard ContinuousClock.now < deadline else {
            service.prefetch([plan])
            return nil
        }
        return DiffSyntaxPlan.codeSpans(plan.input, outcome: service.result(plan.key, plan.input))
    }
}
