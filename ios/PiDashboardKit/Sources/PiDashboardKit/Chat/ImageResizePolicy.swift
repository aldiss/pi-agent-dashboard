import Foundation

public struct ImageResizeDimensions: Equatable, Sendable {
    public let width: Double
    public let height: Double
    public let resized: Bool

    public init(width: Double, height: Double, resized: Bool) {
        self.width = width
        self.height = height
        self.resized = resized
    }
}

/// Pure pre-send image resize policy shared with the native composer.
public enum ImageResizePolicy {
    public static let maxLongEdge: Double = 1568
    public static let lossyQuality: Double = 0.85

    private static let resizableImageMimes: Set<String> = [
        "image/jpeg",
        "image/png",
        "image/webp",
    ]

    /// Matches the web client's exact resize set. GIF stays excluded so redraw
    /// never flattens an animation to its first frame.
    public static func isResizableImageMime(_ mimeType: String) -> Bool {
        resizableImageMimes.contains(mimeType)
    }

    /// Caps the long edge while preserving aspect ratio. Invalid dimensions and
    /// images already within the cap pass through unchanged.
    public static func computeResizeDimensions(
        width: Double,
        height: Double,
        maxLongEdge: Double = ImageResizePolicy.maxLongEdge
    ) -> ImageResizeDimensions {
        guard width.isFinite, height.isFinite,
              width > 0, height > 0,
              maxLongEdge.isFinite, maxLongEdge > 0 else {
            return ImageResizeDimensions(width: width, height: height, resized: false)
        }

        let longEdge = max(width, height)
        guard longEdge > maxLongEdge else {
            return ImageResizeDimensions(width: width, height: height, resized: false)
        }

        let scale = maxLongEdge / longEdge
        return ImageResizeDimensions(
            width: max(1, (width * scale).rounded()),
            height: max(1, (height * scale).rounded()),
            resized: true
        )
    }
}
