#if canImport(UIKit)
import UIKit
import UniformTypeIdentifiers

/// The card's text view, which a paste may also attach to: with
/// `onPasteAttachment` set, a picture on the pasteboard offers Paste in the
/// edit menu and pastes as an attachment instead of text.
///
/// Only pictures: a message carries text and pictures alone (the daemon's
/// `send` takes `text` and `image` blocks), so a recording or a file on the
/// pasteboard offers nothing here rather than something that can't be sent.
public final class AgentInputTextView: UITextView {
    /// Attaches the pasteboard's picture; nil pastes as a plain text view does.
    public var onPasteAttachment: (() -> Void)?

    /// Read without asking for the pasteboard's contents, so no prompt shows.
    private var hasPicture: Bool {
        UIPasteboard.general.hasImages
    }

    public override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)), onPasteAttachment != nil, hasPicture { return true }
        return super.canPerformAction(action, withSender: sender)
    }

    public override func paste(_ sender: Any?) {
        // A copied picture often carries its file name or address as text
        // too: the picture is what was meant. Copied text alone has no picture.
        if let onPasteAttachment, hasPicture {
            onPasteAttachment()
            return
        }
        super.paste(sender)
    }
}
#endif
