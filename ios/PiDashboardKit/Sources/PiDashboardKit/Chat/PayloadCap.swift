import Foundation

/// Boundary robustness constants + pure helpers (Cluster 6). The reducer already
/// truncates oversize bash/raw/tool payloads for DISPLAY (DF#5); this closes the
/// remaining boundary gaps: a hard frame-size guard so a multi-MB WS frame is
/// skipped BEFORE it's decoded into memory, and a duration clamp so clock-skew
/// negatives never store/render. Pure → `swift test`-able.
public enum PayloadCap {
    /// Max WS text-frame size to decode. A frame larger than this is almost certainly
    /// a pathological / hostile payload (the server streams truncated tool output);
    /// `DashboardClient` skips + logs it rather than decoding megabytes. 4 MB is far
    /// above any legitimate frame (events are KB-scale) yet bounds worst-case memory.
    public static let maxFrameBytes = 4 * 1024 * 1024

    /// Whether a frame of `byteCount` is within the decode budget.
    public static func frameWithinBudget(_ byteCount: Int) -> Bool {
        byteCount <= maxFrameBytes
    }

    /// Clamp a duration (ms) to `>= 0` — clock skew between the bridge + client can
    /// make `end - start` negative; a "-3s" elapsed is nonsense. Mirrors the reducer's
    /// inline `max(0, …)` so the rule is unit-tested in one place.
    public static func clampDuration(_ ms: Double) -> Double { max(0, ms) }
}
