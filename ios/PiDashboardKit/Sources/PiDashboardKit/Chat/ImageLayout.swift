import CoreGraphics

/// Pure layout rule for inline chat-message image thumbnails. Mirrors the PWA
/// `ChatView.tsx` inline image — `object-contain max-w/max-h-[300px]`: show the WHOLE
/// image, aspect-preserved, capped by a MAX box (variable size, NOT a fixed square).
/// The native strip caps at 200pt — a mobile-appropriate adaptation of the web's 300
/// for a horizontal chat strip on a ~390pt-wide phone; tap still opens the full lightbox.
///
/// Replaces `.scaledToFill()` into a fixed 140×140 square, which center-cropped the
/// edges off non-square screenshots/photos (a wide image showed only its center third).
/// The SwiftUI `ChatMessageRow.imageStrip` and the unit tests share this one rule.
public enum ImageLayout {
    /// Max thumbnail extent on either axis (points).
    public static let thumbnailBound: CGFloat = 200

    /// Aspect-preserving fit of `source` into a `bound`×`bound` box, never upscaling
    /// (scale clamped to ≤ 1). Returns the WHOLE image's displayed size; the cell
    /// shrink-wraps to it (no letterbox bands). A zero/degenerate `source` falls back
    /// to the square bound.
    public static func thumbnailSize(for source: CGSize, bound: CGFloat = ImageLayout.thumbnailBound) -> CGSize {
        guard source.width > 0, source.height > 0 else {
            return CGSize(width: bound, height: bound)
        }
        let scale = min(bound / source.width, bound / source.height, 1)
        return CGSize(width: (source.width * scale).rounded(),
                      height: (source.height * scale).rounded())
    }
}
