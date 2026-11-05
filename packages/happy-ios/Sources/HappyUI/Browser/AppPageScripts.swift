#if canImport(UIKit)
import UIKit
import WebKit

/// What an app (`ArtifactPageMode`) runs with, before anything of its own:
/// the host stylesheet that fills the screen and never scrolls, a viewport
/// that doesn't zoom and reaches under the notch, the insets it should keep
/// its controls clear of, and its root marked `data-happy-page-mode="app"`.
/// Every document starts that way, so nothing jumps; one that turns out not
/// to declare `happy-page-mode` `app` is given back as it was, and the host
/// told (`modeMessage`).
@MainActor
enum AppPageScripts {
    static let modeMessage = "happyPageMode"

    /// The installed scripts, with `closeBand` (the close button's
    /// height and margins, in points) added to the top of the page's
    /// `--happy-app-inset-*`.
    static func install(in content: WKUserContentController, closeBand: CGFloat) {
        content.removeAllUserScripts()
        content.addUserScript(WKUserScript(source: documentStart(closeBand: closeBand), injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    /// The page's insets, from the safe area as the page itself has it, so
    /// they are never a frame behind `env(safe-area-inset-*)`; registered
    /// as lengths, so a script reads pixels. The host's page inset is 0:
    /// an app gets no padding of the host's.
    static func insetRule(closeBand: CGFloat) -> String {
        let sides = ["top", "right", "bottom", "left"]
        let registered = sides.map { "@property --happy-app-inset-\($0){syntax:'<length>';inherits:true;initial-value:0px}" }.joined()
        let values = sides.map { side in
            side == "top" ? "--happy-app-inset-top:calc(env(safe-area-inset-top) + \(Int(closeBand.rounded()))px)" : "--happy-app-inset-\(side):env(safe-area-inset-\(side))"
        }.joined(separator: ";")
        return registered + ":root{--happy-host-page-inset:0;\(values)}"
    }

    /// The contract's host stylesheet: the page fills the screen and never
    /// scrolls or bounces; nothing is selected or called out by a long
    /// press but what is typed into; a double tap doesn't zoom.
    static let stylesheet = """
    html,body{height:100% !important;margin:0 !important;overflow:hidden !important;overscroll-behavior:none !important}\
    html{-webkit-text-size-adjust:100%;touch-action:manipulation;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}\
    input,textarea,select,[contenteditable],[contenteditable] *{-webkit-user-select:text;user-select:text;-webkit-touch-callout:default}
    """

    static let viewport = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"

    static func documentStart(closeBand: CGFloat) -> String {
        """
        (() => {
          const root = document.documentElement;
          if (!root || window.__happyApp) return;
          window.__happyApp = true;
          root.setAttribute('data-happy-page-mode', 'app');
          const sheet = document.createElement('style');
          sheet.id = 'happy-app-mode';
          sheet.textContent = \(quoted(stylesheet));
          const inset = document.createElement('style');
          inset.id = 'happy-app-insets';
          inset.textContent = \(quoted(insetRule(closeBand: closeBand)));
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
