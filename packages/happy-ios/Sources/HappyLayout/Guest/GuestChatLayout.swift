import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The guest chat (App Clip and invitation links): the session screen's
/// shape without an account.
///
///   - a glass capsule centred under the status bar holds the bot's name and
///     a status line, with a round glass More button at the trailing edge
///     (ChatHeaderView's capsule and avatar slot);
///   - the transcript fills the screen and runs under the capsule and the
///     composer; its insets keep the oldest row below the capsule and the
///     newest above the composer (`ChatScreenLayout`'s 12 and 8);
///   - the composer sits on the keyboard, or on the safe area while the
///     keyboard is down, full width; Reconnect floats 8 above it, centred;
///   - before joining, the name form is a centred column at most 400 wide,
///     between the capsule and the keyboard;
///   - with no conversation, a message is centred in the same space.
public struct GuestChatLayout: Equatable, Sendable {
    public enum Metrics {
        public static let headerTop: CGFloat = 6
        public static let headerHeight: CGFloat = 44
        public static let sidePadding: CGFloat = 16
        public static let moreSize: CGFloat = 44
        public static let capsuleGap: CGFloat = 8
        public static let capsulePaddingH: CGFloat = 16
        /// `ChatScreenLayout.Metrics.olderEdgeExtra`.
        public static let oldestGap: CGFloat = 12
        /// `ChatScreenLayout.Metrics.newerEdgeExtra`.
        public static let newestGap: CGFloat = 8
        public static let retryGap: CGFloat = 8
        public static let columnMaxWidth: CGFloat = 400
        public static let columnPaddingH: CGFloat = 24
        public static let columnTop: CGFloat = 16
        public static let titleGap: CGFloat = 8
        public static let fieldTop: CGFloat = 24
        public static let fieldHeight: CGFloat = 56
        public static let joinTop: CGFloat = 12
        public static let noticeTop: CGFloat = 16
    }

    /// The name form's measured parts.
    public struct Onboarding {
        public var title: Measurable
        public var subtitle: Measurable
        public var joinHeight: CGFloat
        public var notice: Measurable

        public init(title: Measurable, subtitle: Measurable, joinHeight: CGFloat, notice: Measurable) {
            self.title = title
            self.subtitle = subtitle
            self.joinHeight = joinHeight
            self.notice = notice
        }
    }

    public struct Input {
        public var size: CGSize
        public var safeArea: LayoutInsets
        /// The keyboard's top in this view; nil or below the safe area while
        /// it is down.
        public var keyboardTop: CGFloat?
        /// The capsule's two lines, measured; a nil subtitle draws one line.
        public var title: CGSize
        public var subtitle: CGSize?
        /// Nil: no composer (read only, or no conversation yet).
        public var composerHeight: CGFloat?
        public var retry: CGSize?
        public var onboarding: Onboarding?
        /// The centred message shown without a conversation.
        public var message: Measurable?

        public init(
            size: CGSize, safeArea: LayoutInsets, keyboardTop: CGFloat? = nil, title: CGSize, subtitle: CGSize? = nil,
            composerHeight: CGFloat? = nil, retry: CGSize? = nil, onboarding: Onboarding? = nil, message: Measurable? = nil
        ) {
            self.size = size
            self.safeArea = safeArea
            self.keyboardTop = keyboardTop
            self.title = title
            self.subtitle = subtitle
            self.composerHeight = composerHeight
            self.retry = retry
            self.onboarding = onboarding
            self.message = message
        }
    }

    public struct OnboardingFrames: Equatable, Sendable {
        public var title: CGRect
        public var subtitle: CGRect
        public var field: CGRect
        public var join: CGRect
        public var notice: CGRect
    }

    public var capsule: CGRect
    public var title: CGRect
    public var subtitle: CGRect?
    public var more: CGRect
    public var list: CGRect
    /// The transcript's insets at its oldest (top) and newest (bottom) ends.
    public var oldestInset: CGFloat
    public var newestInset: CGFloat
    public var composer: CGRect?
    public var retry: CGRect?
    public var onboarding: OnboardingFrames?
    public var message: CGRect?

    public init(_ input: Input) {
        typealias M = Metrics
        let width = max(0, input.size.width)
        let height = max(0, input.size.height)
        let safeBottom = height - input.safeArea.bottom
        let bottom = min(input.keyboardTop ?? safeBottom, safeBottom)

        let headerY = input.safeArea.top + M.headerTop
        more = CGRect(x: width - M.sidePadding - M.moreSize, y: headerY, width: M.moreSize, height: M.moreSize)
        let capsuleMax = max(0, width - 2 * (M.sidePadding + M.moreSize + M.capsuleGap))
        let contentMax = max(0, capsuleMax - 2 * M.capsulePaddingH)
        let contentWidth = min(contentMax, max(input.title.width, input.subtitle?.width ?? 0))
        let capsuleWidth = min(capsuleMax, max(M.headerHeight, contentWidth + 2 * M.capsulePaddingH))
        capsule = CGRect(x: (width - capsuleWidth) / 2, y: headerY, width: capsuleWidth, height: M.headerHeight)
        let lines = input.title.height + (input.subtitle?.height ?? 0)
        let textX = capsule.minX + (capsuleWidth - contentWidth) / 2
        let titleFrame = CGRect(x: textX, y: headerY + (M.headerHeight - lines) / 2, width: contentWidth, height: input.title.height)
        title = titleFrame
        subtitle = input.subtitle.map { CGRect(x: textX, y: titleFrame.maxY, width: contentWidth, height: $0.height) }

        var newestEdge = bottom
        if let composerHeight = input.composerHeight {
            let frame = CGRect(x: 0, y: bottom - composerHeight, width: width, height: composerHeight)
            composer = frame
            newestEdge = frame.minY
        } else {
            composer = nil
        }
        let retryBottom = newestEdge - M.retryGap
        retry = input.retry.map { CGRect(x: (width - $0.width) / 2, y: retryBottom - $0.height, width: $0.width, height: $0.height) }
        list = CGRect(x: 0, y: 0, width: width, height: height)
        let capsuleFrame = capsule
        oldestInset = capsuleFrame.maxY + M.oldestGap
        newestInset = height - newestEdge + M.newestGap

        let columnWidth = min(M.columnMaxWidth, max(0, width - 2 * M.columnPaddingH))
        let columnX = (width - columnWidth) / 2
        let regionTop = capsuleFrame.maxY + M.columnTop
        let region = max(0, newestEdge - regionTop)
        if let form = input.onboarding {
            let titleHeight = form.title.height(fitting: columnWidth)
            let subtitleHeight = form.subtitle.height(fitting: columnWidth)
            let noticeHeight = form.notice.height(fitting: columnWidth)
            let total = titleHeight + M.titleGap + subtitleHeight + M.fieldTop + M.fieldHeight + M.joinTop + form.joinHeight
                + M.noticeTop + noticeHeight
            var y = regionTop + max(0, (region - total) / 2)
            let formTitle = CGRect(x: columnX, y: y, width: columnWidth, height: titleHeight)
            y = formTitle.maxY + M.titleGap
            let subtitleFrame = CGRect(x: columnX, y: y, width: columnWidth, height: subtitleHeight)
            y = subtitleFrame.maxY + M.fieldTop
            let field = CGRect(x: columnX, y: y, width: columnWidth, height: M.fieldHeight)
            y = field.maxY + M.joinTop
            let join = CGRect(x: columnX, y: y, width: columnWidth, height: form.joinHeight)
            y = join.maxY + M.noticeTop
            let notice = CGRect(x: columnX, y: y, width: columnWidth, height: noticeHeight)
            onboarding = OnboardingFrames(title: formTitle, subtitle: subtitleFrame, field: field, join: join, notice: notice)
        } else {
            onboarding = nil
        }
        message = input.message.map { measurable in
            let size = measurable.size(fitting: columnWidth)
            return CGRect(x: columnX, y: regionTop + max(0, (region - size.height) / 2), width: columnWidth, height: size.height)
        }
    }
}

/// The transcript's rows stacked oldest first, each as tall as it was
/// measured, full width.
public struct GuestTranscriptLayout: Equatable, Sendable {
    public var rows: [CGRect]
    public var contentSize: CGSize

    public init(width: CGFloat, heights: [CGFloat]) {
        var y: CGFloat = 0
        rows = heights.map { height in
            defer { y += height }
            return CGRect(x: 0, y: y, width: width, height: height)
        }
        contentSize = CGSize(width: width, height: y)
    }
}
