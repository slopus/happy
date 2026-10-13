#if canImport(UIKit)
import HappyLayout
import UIKit

/// A UICollectionViewLayout over `ChatListLayout`: exact frames from
/// measured heights, found by binary search, so a long chat costs the same
/// to scroll as a short one. The collection view is flipped (row 0, the
/// newest, at the bottom of the screen) and every cell is flipped back by
/// its attributes' transform.
final class ChatCollectionLayout: UICollectionViewLayout {
    static let flip = CGAffineTransform(scaleX: 1, y: -1)

    var model = ChatListLayout(width: 0, heights: [])

    /// Where the visible min y must land after the update being applied
    /// (`ChatScrollAnchor`); nil leaves UIKit's proposal alone.
    var anchoredVisibleMinY: CGFloat?

    override var collectionViewContentSize: CGSize {
        model.contentSize
    }

    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
        model.rows(from: rect.minY, to: rect.maxY).map { attributes(row: $0) }
    }

    override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        guard indexPath.item < model.count else { return nil }
        return attributes(row: indexPath.item)
    }

    private func attributes(row: Int) -> UICollectionViewLayoutAttributes {
        let attributes = UICollectionViewLayoutAttributes(forCellWith: IndexPath(item: row, section: 0))
        let frame = model.frame(ofRow: row)
        attributes.size = frame.size
        attributes.center = CGPoint(x: frame.midX, y: frame.midY)
        attributes.transform = Self.flip
        return attributes
    }

    override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool {
        // Scrolling never changes a frame; a new width is re-measured by the
        // list first, which then installs a new model.
        false
    }

    override func targetContentOffset(forProposedContentOffset proposed: CGPoint) -> CGPoint {
        guard let collectionView, let target = anchoredVisibleMinY else { return proposed }
        return CGPoint(x: proposed.x, y: target - collectionView.adjustedContentInset.top)
    }
}
#endif
