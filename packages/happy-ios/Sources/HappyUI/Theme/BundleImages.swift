#if canImport(UIKit)
import UIKit

extension UIImage {
    /// An image from HappyUI's bundle.
    static func happy(_ name: String) -> UIImage? {
        UIImage(named: name, in: .module, compatibleWith: nil)
    }
}
#endif
