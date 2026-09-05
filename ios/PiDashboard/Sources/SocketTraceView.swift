import SwiftUI
import PiDashboardKit

/// Operator-readable dump of the socket lifecycle trace (B10).
///
/// The trace is worthless if it cannot leave the device. B10 has survived several
/// investigations because every instrument so far produced signals consistent with
/// more than one cause; this view exists so ONE captured flap can be copied out and
/// read against the decision table, rather than described from memory.
///
/// Read-only. Nothing here changes connection behaviour.
struct SocketTraceView: View {
    @Environment(\.theme) private var theme
    @State private var text: String = ""
    @State private var copied = false
    @State private var loading = true

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if loading {
                    Text("Reading trace…")
                        .font(.callout)
                        .foregroundStyle(theme.textSecondary)
                } else if text.isEmpty {
                    // An empty trace is a real answer, not a broken screen: it means no
                    // socket lifecycle events were recorded at all, which is itself
                    // diagnostic. Say so rather than showing a blank pane.
                    Text("No socket events recorded yet.\n\nOpen the dashboard, let it connect or fail once, then come back.")
                        .font(.callout)
                        .foregroundStyle(theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text(text)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(theme.textPrimary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("socket-trace-body")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        }
        .background(theme.bgPrimary)
        .navigationTitle("Connection trace")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    UIPasteboard.general.string = text
                    copied = true
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                }
                .disabled(text.isEmpty)
                .accessibilityIdentifier("socket-trace-copy")
            }
        }
        .task {
            text = await SocketTraceLog.shared.rendered()
            loading = false
        }
    }
}
