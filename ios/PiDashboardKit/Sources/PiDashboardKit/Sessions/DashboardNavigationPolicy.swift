public enum DashboardNavigationPolicy {
    public enum Width: Sendable, Equatable {
        case compact
        case regular
    }

    public enum Layout: Sendable, Equatable {
        case stack
        case splitView
    }

    public static func layout(for width: Width?) -> Layout {
        width == .regular ? .splitView : .stack
    }
}
