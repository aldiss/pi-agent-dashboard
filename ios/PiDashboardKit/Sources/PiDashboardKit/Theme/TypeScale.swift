import Foundation

/// Dynamic-Type policy for the app's text roles (Cluster 4), kept UI-free so the
/// cap decisions are `swift test`-able. SwiftUI does the actual scaling; this type
/// only answers "which semantic role is this, and how far may it scale before the
/// layout breaks?" The app maps a role → a semantic font + a `.dynamicTypeSize(...cap)`
/// ceiling. Roles on fixed-width / single-line / dense surfaces cap earlier; flowing
/// prose scales all the way.
public enum TypeRole: String, Sendable, CaseIterable {
    case title          // screen title ("pi dashboard")
    case sectionHeader  // tier headers, settings section labels
    case cardTitle      // session-card display name (single line beside a chip)
    case body           // chat prose, settings values — flows, scales freely
    case label          // model label, dir path, control text
    case caption        // timestamps, sub-labels
    case badge          // pills / chips / count badges (tight capsules)

    /// The maximum Dynamic Type step this role may scale to before its layout breaks,
    /// expressed as a stable ordinal (mirrors `DynamicTypeSize`'s order, which the app
    /// maps to the SwiftUI enum). `nil` = no cap (scale to the largest accessibility
    /// size). Dense / single-line-beside-siblings roles cap at `.accessibility3`;
    /// flowing text is uncapped.
    ///
    /// Ordinal scale (matches DynamicTypeSize order):
    ///   0 xSmall · 1 small · 2 medium · 3 large(default) · 4 xL · 5 xxL · 6 xxxL ·
    ///   7 a11y1 · 8 a11y2 · 9 a11y3 · 10 a11y4 · 11 a11y5
    public var dynamicTypeCapOrdinal: Int? {
        switch self {
        case .title:         return TypeScale.accessibility3   // big already; don't blow the nav
        case .sectionHeader: return TypeScale.accessibility3
        case .cardTitle:     return TypeScale.accessibility3   // shares the row with a status chip
        case .badge:         return TypeScale.accessibility2   // tight capsule — cap sooner
        case .label:         return TypeScale.accessibility3
        case .caption:       return TypeScale.accessibility3
        case .body:          return nil                        // flowing prose — scale freely
        }
    }
}

/// Numeric anchors + pure helpers for the Dynamic-Type policy.
public enum TypeScale {
    // DynamicTypeSize ordinals (stable — mirror the SwiftUI enum's declaration order).
    public static let large = 3            // the default size
    public static let accessibility1 = 7
    public static let accessibility2 = 8
    public static let accessibility3 = 9
    public static let accessibility5 = 11  // the largest

    /// Minimum tap-target edge (pt) per Apple HIG — controls must stay ≥ this as text
    /// scales.
    public static let minTapTarget: CGFloat = 44

    /// Clamp a current Dynamic-Type ordinal to a role's cap (min). `cap == nil` →
    /// unchanged. Pure — the app applies the resulting ceiling via `.dynamicTypeSize`.
    public static func cappedOrdinal(current: Int, cap: Int?) -> Int {
        guard let cap else { return current }
        return min(current, cap)
    }

    /// Whether a role caps below the largest accessibility size (i.e. it constrains
    /// scaling at all). `body` does not; the dense roles do.
    public static func isCapped(_ role: TypeRole) -> Bool {
        role.dynamicTypeCapOrdinal != nil
    }
}
