#if canImport(UIKit)
import HappyCore
import HappyLayout
import ImageIO
import UIKit

/// An account's profile pictures and thumbhash placeholders as UIImages,
/// decoded off the main thread by the account's own `AccountPictures`.
extension AccountPictures {
    /// A picture already decoded, or nil.
    func cachedImage(_ url: URL) -> UIImage? {
        cached(url) as? UIImage
    }

    /// The picture at `url`, or nil when it can't be had.
    func image(_ url: URL) async -> UIImage? {
        await picture(url, decode: AccountPictureImages.decode) as? UIImage
    }

    /// A thumbhash already decoded, or nil.
    func cachedPlaceholderImage(_ thumbhash: String) -> UIImage? {
        cachedPlaceholder(thumbhash) as? UIImage
    }

    /// The thumbhash as a picture, or nil when it is not one.
    func placeholderImage(_ thumbhash: String) async -> UIImage? {
        await placeholder(thumbhash, make: AccountPictureImages.placeholder) as? UIImage
    }
}

enum AccountPictureImages {
    /// The largest a profile picture is drawn: the Settings header's, at 3x.
    static let maxPixelSize = Int(SettingsProfileHeaderLayout.Metrics.avatarSize * 3)

    /// Bytes as a bitmap no larger than it is drawn, upright and decoded
    /// now rather than when first drawn on main.
    static let decode: AccountPictures.Decode<Data> = { data in
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else {
            return nil
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return (picture: UIImage(cgImage: image) as AccountPictures.Picture, cost: image.bytesPerRow * image.height)
    }

    /// ThumbHash's pixels as a picture (expo-image's placeholder).
    static let placeholder: AccountPictures.Decode<String> = { base64 in
        guard let decoded = ThumbHash.decode(base64: base64),
              let provider = CGDataProvider(data: Data(decoded.rgba) as CFData),
              let image = CGImage(
                  width: decoded.width,
                  height: decoded.height,
                  bitsPerComponent: 8,
                  bitsPerPixel: 32,
                  bytesPerRow: decoded.width * 4,
                  space: CGColorSpaceCreateDeviceRGB(),
                  bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
                  provider: provider,
                  decode: nil,
                  shouldInterpolate: true,
                  intent: .defaultIntent
              ) else { return nil }
        return (picture: UIImage(cgImage: image) as AccountPictures.Picture, cost: decoded.rgba.count)
    }
}
#endif
