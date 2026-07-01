import SwiftUI
import PiDashboardKit

/// Bridges the core `TypeRole` Dynamic-Type policy (unit-tested in `PiDashboardKit`)
/// to SwiftUI (Cluster 4). `.dynamicTypeCap(.cardTitle)` applies that role's scaling
/// ceiling so a layout-fragile surface (single-line name beside a chip, a tight
/// capsule) can't blow up at accessibility sizes — while `body` prose scales freely.
/// The cap is an UPPER bound: default and smaller sizes are unaffected (no regression).
extension View {
    @ViewBuilder
    func dynamicTypeCap(_ role: TypeRole) -> some View {
        if let ceiling = role.dynamicTypeCeiling {
            self.dynamicTypeSize(...ceiling)
        } else {
            self // .body → uncapped, scales all the way
        }
    }
}

private extension TypeRole {
    /// Map the core ordinal cap → the SwiftUI `DynamicTypeSize` ceiling. Ordinals
    /// mirror `DynamicTypeSize`'s declaration order (see `TypeScale`).
    var dynamicTypeCeiling: DynamicTypeSize? {
        switch dynamicTypeCapOrdinal {
        case TypeScale.accessibility2: return .accessibility2
        case TypeScale.accessibility3: return .accessibility3
        case .some: return .accessibility3   // any other cap → the safe default ceiling
        case nil: return nil
        }
    }
}
