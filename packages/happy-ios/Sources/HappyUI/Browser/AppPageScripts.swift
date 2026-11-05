#if canImport(UIKit)
import HappyCore
import UIKit
import WebKit

/// What an app (`ArtifactPageMode`) runs with, before anything of its own:
/// the host stylesheet that fills the screen and never scrolls, a viewport
/// that doesn't zoom and reaches under the notch, the insets it should keep
/// its controls clear of and where the close button is, its root marked
/// `data-happy-page-mode="app"` and `data-happy-app-close`, and
/// `window.happyApp.close()`, which asks the host to close it.
/// Every document starts that way, so nothing jumps; one that turns out not
/// to declare `happy-page-mode` `app` is given back as it was, and the host
/// told (`modeMessage`).
@MainActor
enum AppPageScripts {
    static let modeMessage = "happyPageMode"
    /// `window.happyApp`'s messages to the host: `{type: "close"}`.
    static let appMessage = "happyApp"

    /// Where the close button is, as the page is told: its corner, its box
    /// (the button and its margin all round, in points), and whether start
    /// is the right side.
    struct Close: Equatable {
        var corner: ArtifactAppClose
        var box: CGFloat
        var rightToLeft: Bool
    }

    /// The installed scripts, for an app whose close button is `close`.
    static func install(in content: WKUserContentController, close: Close) {
        content.removeAllUserScripts()
        content.addUserScript(WKUserScript(source: documentStart(close: close), injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    /// The page's insets and the close button's box, from the safe area as
    /// the page itself has it, so they are never a frame behind
    /// `env(safe-area-inset-*)` and follow every rotation and resize;
    /// registered as lengths, so a script reads pixels. The button's box
    /// goes into the inset on its edge; without a button, the insets are
    /// the safe area and the box is 0. The host's page inset is 0: an app
    /// gets no padding of the host's.
    static func insetRule(_ close: Close) -> String {
        let box = "\(Int(close.box.rounded()))px"
        let corner = close.corner
        func inset(_ side: String) -> String {
            let band = (side == "top" && corner.isTop) || (side == "bottom" && corner.isBottom)
            return band ? "calc(env(safe-area-inset-\(side)) + \(box))" : "env(safe-area-inset-\(side))"
        }
        let right = corner.isEnd != close.rightToLeft
        let rect: [(String, String)] = corner == .none ? [("x", "0px"), ("y", "0px"), ("width", "0px"), ("height", "0px")] : [
            ("x", right ? "calc(100vw - env(safe-area-inset-right) - \(box))" : "env(safe-area-inset-left)"),
            ("y", corner.isTop ? "env(safe-area-inset-top)" : "calc(100vh - env(safe-area-inset-bottom) - \(box))"),
            ("width", box), ("height", box),
        ]
        let sides = ["top", "right", "bottom", "left"]
        let names = sides.map { "--happy-app-inset-\($0)" } + rect.map { "--happy-app-close-\($0.0)" }
        let registered = names.map { "@property \($0){syntax:'<length>';inherits:true;initial-value:0px}" }.joined()
        let values = sides.map { "--happy-app-inset-\($0):\(inset($0))" } + rect.map { "--happy-app-close-\($0.0):\($0.1)" }
        return registered + ":root{--happy-host-page-inset:0;\(values.joined(separator: ";"))}"
    }

    /// The contract's host stylesheet: the page fills the screen and never
    /// scrolls or bounces; nothing is selected or called out by a long
    /// press but what is typed into; a double tap doesn't zoom. Behind the
    /// page is black until it paints; one that names no background of its
    /// own gets its scheme's, as in a browser, which it overrides.
    static let stylesheet = """
    html{background-color:Canvas}\
    html,body{height:100% !important;margin:0 !important;overflow:hidden !important;overscroll-behavior:none !important}\
    html{-webkit-text-size-adjust:100%;touch-action:manipulation;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}\
    input,textarea,select,[contenteditable],[contenteditable] *{-webkit-user-select:text;user-select:text;-webkit-touch-callout:default}
    """

    static let viewport = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"

    static func documentStart(close: Close) -> String {
        """
        (() => {
          const root = document.documentElement;
          if (!root || window.__happyApp) return;
          window.__happyApp = true;
          root.setAttribute('data-happy-page-mode', 'app');
          root.setAttribute('data-happy-app-close', \(quoted(close.corner.rawValue)));
          window.happyApp = Object.freeze({ close() { window.webkit.messageHandlers.\(appMessage).postMessage({ type: 'close' }); } });
          const sheet = document.createElement('style');
          sheet.id = 'happy-app-mode';
          sheet.textContent = \(quoted(stylesheet));
          const inset = document.createElement('style');
          inset.id = 'happy-app-insets';
          inset.textContent = \(quoted(insetRule(close)));
          const viewport = document.createElement('meta');
          viewport.name = 'viewport';
          viewport.content = \(quoted(viewport));
          root.insertBefore(inset, root.firstChild);
          root.insertBefore(sheet, inset);
          root.appendChild(viewport);
          let declared = null;
          const seen = (node) => {
            if (node.nodeName !== 'META' || node === viewport) return;
            const name = (node.getAttribute('name') || '').trim().toLowerCase();
            // The last viewport wins: ours stays after the page's.
            if (name === 'viewport') (document.head || root).appendChild(viewport);
            else if (name === 'happy-page-mode' && declared === null) declared = (node.getAttribute('content') || '').trim().toLowerCase() === 'app';
          };
          const observer = new MutationObserver((records) => {
            for (const record of records) for (const node of record.addedNodes) seen(node);
          });
          observer.observe(root, { childList: true, subtree: true });
          document.addEventListener('DOMContentLoaded', () => {
            observer.disconnect();
            if (declared !== true) {
              root.removeAttribute('data-happy-page-mode');
              root.removeAttribute('data-happy-app-close');
              delete window.happyApp;
              sheet.remove(); inset.remove(); viewport.remove();
            }
            window.webkit.messageHandlers.\(modeMessage).postMessage(declared === true ? 'app' : 'page');
          }, { once: true });
        })();
        """
    }

    /// `text` as a JavaScript string literal.
    static func quoted(_ text: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [text])) ?? Data("[\"\"]".utf8)
        return String(String(decoding: data, as: UTF8.self).dropFirst().dropLast())
    }

    /// The page asking to close, without the content controller keeping the view.
    final class Requests: NSObject, WKScriptMessageHandler {
        private let close: @MainActor () -> Void
        init(close: @escaping @MainActor () -> Void) { self.close = close }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard (message.body as? [String: Any])?["type"] as? String == "close" else { return }
            MainActor.assumeIsolated { close() }
        }
    }

    /// The mode messages, without the content controller keeping the view.
    final class Modes: NSObject, WKScriptMessageHandler {
        private let changed: @MainActor (Bool) -> Void
        init(_ changed: @escaping @MainActor (Bool) -> Void) { self.changed = changed }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let mode = message.body as? String else { return }
            MainActor.assumeIsolated { changed(mode == "app") }
        }
    }
}
#endif
