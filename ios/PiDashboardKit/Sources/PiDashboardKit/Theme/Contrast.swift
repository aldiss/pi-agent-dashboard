import Foundation

/// Pure WCAG 2.x contrast-ratio math (Cluster 3). Lets the theme tokens be
/// contrast-audited in `swift test` — no SwiftUI, no rendering — so a light-mode
/// palette that fails AA can't silently regress. Parses `#rgb` / `#rrggbb` /
/// `#rrggbbaa` hex (alpha ignored — contrast is defined on the opaque colour; a
/// translucent token is checked at its solid value). `rgba(...)` / unparseable →
/// nil luminance (caller treats as "unknown", never a false pass).
public enum Contrast {

    /// WCAG AA thresholds: 4.5:1 for normal text, 3.0:1 for large text (≥18pt / ≥14pt
    /// bold) AND for UI components / graphical objects (dots, chips, icons).
    public static let aaText: Double = 4.5
    public static let aaLargeOrUI: Double = 3.0

    /// Relative luminance of a hex colour (WCAG formula), or nil when unparseable.
    public static func relativeLuminance(_ hex: String) -> Double? {
        guard let (r, g, b) = rgb(hex) else { return nil }
        func chan(_ c: Int) -> Double {
            let s = Double(c) / 255.0
            return s <= 0.03928 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)
    }

    /// Contrast ratio between two hex colours: (L_hi + 0.05) / (L_lo + 0.05), in
    /// `1.0...21.0`. Symmetric. nil when either colour is unparseable.
    public static func ratio(_ a: String, _ b: String) -> Double? {
        guard let la = relativeLuminance(a), let lb = relativeLuminance(b) else { return nil }
        let hi = max(la, lb), lo = min(la, lb)
        return (hi + 0.05) / (lo + 0.05)
    }

    /// Whether `foreground` on `background` meets WCAG AA. `largeOrUI: true` uses the
    /// 3.0 threshold (large text / UI dots+chips+icons); false uses 4.5 (body text).
    /// Unparseable → false (never a false pass).
    public static func meetsAA(foreground: String, background: String, largeOrUI: Bool) -> Bool {
        guard let r = ratio(foreground, background) else { return false }
        return r >= (largeOrUI ? aaLargeOrUI : aaText)
    }

    // MARK: hex parsing

    /// Parse `#rgb` / `#rrggbb` / `#rrggbbaa` (alpha dropped) → (r,g,b) 0…255. The
    /// `rgba(...)` functional form + malformed strings → nil.
    static func rgb(_ raw: String) -> (Int, Int, Int)? {
        var s = raw.trimmingCharacters(in: .whitespaces)
        guard s.hasPrefix("#") else { return nil } // rgba(...) / named → unknown
        s.removeFirst()
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }           // #rgb → #rrggbb
        if s.count == 8 { s = String(s.prefix(6)) }                        // #rrggbbaa → drop alpha
        guard s.count == 6, let v = Int(s, radix: 16) else { return nil }
        return ((v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF)
    }
}
