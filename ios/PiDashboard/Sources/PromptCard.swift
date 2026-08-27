import SwiftUI
import PiDashboardKit

/// Native PromptBus renderer. Covers the methods produced by `ask_user`; batch
/// questions arrive sequentially through the same individual request types.
struct PromptCard: View {
    let request: DashboardPromptRequest
    let isResponding: Bool
    let onRespond: (_ answer: String?, _ cancelled: Bool) -> Void

    @Environment(\.theme) private var theme
    @State private var input: String
    @State private var selected: Set<String> = []

    init(request: DashboardPromptRequest, isResponding: Bool,
         onRespond: @escaping (_ answer: String?, _ cancelled: Bool) -> Void) {
        self.request = request
        self.isResponding = isResponding
        self.onRespond = onRespond
        _input = State(initialValue: PromptPresentation.initialText(
            method: request.prompt.method, defaultValue: request.prompt.defaultValue))
    }

    private var method: String { request.prompt.method.lowercased() }
    private var options: [String] {
        if !request.prompt.options.isEmpty { return request.prompt.options }
        return request.component.props["options"]?.arrayValue?.compactMap(\.stringValue) ?? []
    }
    private var hasCancelOption: Bool { options.contains(where: PromptPresentation.isCancelOption) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "questionmark.bubble.fill")
                    .foregroundStyle(theme.accentBlue)
                VStack(alignment: .leading, spacing: 4) {
                    Text(request.prompt.question)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(theme.textPrimary)
                    if let message = request.message, !message.isEmpty {
                        MarkdownText(content: message)
                            .font(.caption)
                            .foregroundStyle(theme.textSecondary)
                    }
                }
            }

            controls

            if isResponding {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Sending response…")
                        .font(.caption)
                        .foregroundStyle(theme.textTertiary)
                }
                .accessibilityIdentifier("prompt-responding")
            }
        }
        .padding(14)
        .background(theme.bgSurface)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(theme.accentBlue.opacity(0.35), lineWidth: 1)
        )
        .disabled(isResponding)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("prompt-card-\(request.promptId)")
    }

    @ViewBuilder private var controls: some View {
        switch method {
        case "confirm":
            HStack(spacing: 10) {
                responseButton("Allow", answer: "true", tint: .green)
                responseButton("Deny", answer: "false", tint: theme.accentRed)
                cancelButton
            }

        case "select":
            VStack(alignment: .leading, spacing: 8) {
                ForEach(options, id: \.self) { option in
                    Button {
                        if PromptPresentation.isCancelOption(option) { onRespond(nil, true) }
                        else { onRespond(option, false) }
                    } label: {
                        HStack {
                            Text(option).multilineTextAlignment(.leading)
                            Spacer()
                            Image(systemName: "chevron.right")
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.bordered)
                    .tint(theme.accentBlue)
                    .accessibilityIdentifier("prompt-option-\(option)")
                }
                if !hasCancelOption { cancelButton }
            }

        case "multiselect":
            VStack(alignment: .leading, spacing: 8) {
                Button {
                    selected = PromptPresentation.toggledAll(current: selected, options: options)
                } label: {
                    HStack {
                        Image(systemName: selected.count == Set(options).count && !options.isEmpty
                              ? "checkmark.square.fill" : "square")
                        Text(selected.count == Set(options).count && !options.isEmpty
                             ? "Deselect all" : "Select all")
                        Spacer()
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(theme.accentBlue)
                .accessibilityIdentifier("prompt-multiselect-all")

                ForEach(options, id: \.self) { option in
                    Button {
                        if selected.contains(option) { selected.remove(option) }
                        else { selected.insert(option) }
                    } label: {
                        HStack {
                            Image(systemName: selected.contains(option) ? "checkmark.square.fill" : "square")
                            Text(option).multilineTextAlignment(.leading)
                            Spacer()
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(selected.contains(option) ? theme.accentBlue : theme.textPrimary)
                    .accessibilityIdentifier("prompt-multiselect-\(option)")
                }
                HStack {
                    Button("Submit") { onRespond(encodedSelection(), false) }
                        .buttonStyle(.borderedProminent)
                        .tint(theme.accentBlue)
                    cancelButton
                }
            }

        case "input":
            VStack(alignment: .leading, spacing: 8) {
                TextField(request.prompt.defaultValue ?? "Response", text: $input)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("prompt-input")
                inputActions
            }

        case "editor":
            VStack(alignment: .leading, spacing: 8) {
                TextEditor(text: $input)
                    .frame(minHeight: 100)
                    .padding(6)
                    .background(theme.bgSecondary)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .accessibilityIdentifier("prompt-editor")
                inputActions
            }

        case "notify":
            Button("Dismiss") { onRespond("", false) }
                .buttonStyle(.borderedProminent)
                .tint(theme.accentBlue)

        default:
            VStack(alignment: .leading, spacing: 8) {
                Text("This prompt type (\(request.prompt.method)) is not supported in the native app yet.")
                    .font(.caption)
                    .foregroundStyle(theme.textSecondary)
                cancelButton
            }
        }
    }

    private var inputActions: some View {
        HStack {
            Button("Submit") { onRespond(input, false) }
                .buttonStyle(.borderedProminent)
                .tint(theme.accentBlue)
            cancelButton
        }
    }

    private func responseButton(_ title: String, answer: String, tint: Color) -> some View {
        Button(title) { onRespond(answer, false) }
            .buttonStyle(.borderedProminent)
            .tint(tint)
            .accessibilityIdentifier("prompt-\(title.lowercased())")
    }

    private var cancelButton: some View {
        Button("Cancel") { onRespond(nil, true) }
            .buttonStyle(.bordered)
            .tint(theme.textSecondary)
            .accessibilityIdentifier("prompt-cancel")
    }

    private func encodedSelection() -> String {
        let ordered = options.filter(selected.contains)
        guard let data = try? JSONEncoder().encode(ordered) else { return "[]" }
        return String(decoding: data, as: UTF8.self)
    }
}
