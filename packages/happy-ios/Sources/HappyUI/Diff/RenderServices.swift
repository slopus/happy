#if canImport(UIKit)
import HappyCore

/// The account's diff documents and syntax colour, which every plan that
/// draws a diff, a command's output or a code block is built with. A plan
/// uses the services of the account it is planned for, never another's and
/// never a global one; when the account stops they are closed, and a plan
/// still being made draws plain or nothing. Such a plan is stale: every
/// screen checks `isClosed` when a plan lands and drops it, since the
/// account closes them before the open account changes.
///
/// Equal when they are the same instances, so a row planned for another
/// account is planned again.
struct RenderServices: Equatable, Sendable {
    let diffDocuments: DiffDocumentCache
    let diffSyntax: DiffSyntaxService
    let codeSyntax: CodeSyntaxService

    init(_ account: AccountSession) {
        diffDocuments = account.diffDocuments
        diffSyntax = account.diffSyntax
        codeSyntax = account.codeSyntax
    }

    /// The account stopped. Closing is for good, so a plan that saw any of
    /// them closed sees this true when it lands.
    var isClosed: Bool {
        diffDocuments.isClosed || diffSyntax.isClosed || codeSyntax.isClosed
    }

    /// Services of their own, for tests and previews.
    static func isolated() -> RenderServices {
        RenderServices(diffDocuments: DiffDocumentCache(), diffSyntax: DiffSyntaxService(), codeSyntax: CodeSyntaxService())
    }

    private init(diffDocuments: DiffDocumentCache, diffSyntax: DiffSyntaxService, codeSyntax: CodeSyntaxService) {
        self.diffDocuments = diffDocuments
        self.diffSyntax = diffSyntax
        self.codeSyntax = codeSyntax
    }

    static func == (lhs: RenderServices, rhs: RenderServices) -> Bool {
        lhs.diffDocuments === rhs.diffDocuments && lhs.diffSyntax === rhs.diffSyntax && lhs.codeSyntax === rhs.codeSyntax
    }
}
#endif
