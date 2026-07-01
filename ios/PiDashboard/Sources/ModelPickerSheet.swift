import SwiftUI
import PiDashboardKit

/// Model + thinking-level picker sheet — native mirror of the PWA `ModelSelector` +
/// `ModelReasoningSheet`. On appear it requests the model list; rows show
/// `provider/id` with the current model checkmarked; a provider filter + search
/// narrow a long list; a segmented control sets the thinking level. Selections route
/// through the store; the server confirms via `session_updated` (title/checkmark
/// update through the session registry). Identifier `model-picker`.
struct ModelPickerSheet: View {
    let sessionId: String

    @Environment(DashboardStore.self) private var store
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss

    @State private var search = ""
    @State private var providerFilter = ""

    /// pi reasoning levels (verbatim from `ModelReasoningSheet.tsx`).
    private let thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"]

    private var models: [ModelInfo] { store.availableModels[sessionId] ?? [] }
    private var session: DashboardSession? { store.sessions[sessionId] }
    private var currentModel: String? { session?.model }
    private var currentThinking: String { session?.thinkingLevel ?? "off" }

    private var providers: [String] {
        Array(Set(models.map { $0.provider })).sorted()
    }

    private var filteredModels: [ModelInfo] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        return models
            .filter { providerFilter.isEmpty || $0.provider == providerFilter }
            .filter { q.isEmpty || $0.qualified.lowercased().contains(q) }
            .sorted { ($0.provider, $0.id) < ($1.provider, $1.id) }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    searchField
                    if providers.count > 1 { providerChips }
                    modelList
                    thinkingControl
                }
                .padding(16)
            }
            .background(theme.bgPrimary)
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }.foregroundStyle(theme.accentBlue)
                }
            }
        }
        .accessibilityIdentifier("model-picker")
        .task { await store.requestModels(sessionId) }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(theme.textTertiary)
            TextField("Search models", text: $search)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .foregroundStyle(theme.textPrimary)
        }
        .padding(10)
        .background(theme.bgTertiary)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var providerChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip("All", active: providerFilter.isEmpty) { providerFilter = "" }
                ForEach(providers, id: \.self) { p in
                    chip(p, active: providerFilter == p) { providerFilter = p }
                }
            }
        }
    }

    private func chip(_ label: String, active: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.caption.weight(.medium))
                .foregroundStyle(active ? theme.bgPrimary : theme.textSecondary)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(active ? theme.accentBlue : theme.bgTertiary)
                .clipShape(Capsule())
        }
    }

    @ViewBuilder private var modelList: some View {
        if models.isEmpty {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small).tint(theme.textTertiary)
                Text("Loading models…").font(.callout).foregroundStyle(theme.textTertiary)
            }
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 24)
        } else {
            VStack(spacing: 6) {
                ForEach(filteredModels) { model in
                    Button {
                        Task {
                            await store.setModel(sessionId, provider: model.provider, modelId: model.id)
                            dismiss()
                        }
                    } label: {
                        HStack {
                            Text(model.qualified)
                                .font(.callout)
                                .foregroundStyle(theme.textPrimary)
                                .lineLimit(1)
                            Spacer()
                            if model.qualified == currentModel {
                                Image(systemName: "checkmark").foregroundStyle(theme.accentBlue)
                            }
                        }
                        .padding(.horizontal, 14).padding(.vertical, 12)
                        .background(theme.bgTertiary)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .accessibilityIdentifier("model-row-\(model.provider)-\(model.id)")
                }
            }
        }
    }

    private var thinkingControl: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Thinking level", systemImage: "lightbulb")
                .font(.caption.weight(.semibold))
                .foregroundStyle(theme.textTertiary)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 3), spacing: 6) {
                ForEach(thinkingLevels, id: \.self) { level in
                    Button {
                        Task { await store.setThinkingLevel(sessionId, level: level) }
                    } label: {
                        Text(level)
                            .font(.footnote.weight(.medium))
                            .dynamicTypeCap(.badge)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .foregroundStyle(level == currentThinking ? theme.bgPrimary : theme.textSecondary)
                            .background(level == currentThinking ? theme.accentBlue : theme.bgTertiary)
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .accessibilityIdentifier("thinking-row-\(level)")
                }
            }
        }
    }
}
