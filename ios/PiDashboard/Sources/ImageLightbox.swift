import SwiftUI

/// Full-screen image lightbox — mirrors the PWA `ImageLightbox`. Pinch to zoom
/// (`MagnificationGesture`), drag to pan when zoomed, swipe-down or tap to dismiss,
/// dark backdrop. Presented over the chat via `.fullScreenCover`.
struct ImageLightbox: View {
    let image: UIImage
    let onDismiss: () -> Void

    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero
    /// Vertical drag distance while at rest (scale==1) — drives swipe-down dismiss.
    @State private var dismissDrag: CGFloat = 0

    private let minScale: CGFloat = 1
    private let maxScale: CGFloat = 5

    /// Backdrop fades as the at-rest image is dragged down toward dismissal.
    private var backdropOpacity: Double {
        let faded: CGFloat = 1 - (dismissDrag / 400)
        return Double(max(0, faded))
    }

    var body: some View {
        ZStack {
            Color.black
                .opacity(backdropOpacity)
                .ignoresSafeArea()

            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .scaleEffect(scale)
                .offset(x: offset.width, y: offset.height + dismissDrag)
                .gesture(zoomGesture)
                .gesture(scale > 1 ? panGesture : nil)
                .simultaneousGesture(scale <= 1 ? dismissGesture : nil)
                .onTapGesture(count: 2) { toggleZoom() }

            VStack {
                HStack {
                    Spacer()
                    Button(action: onDismiss) {
                        Image(systemName: "xmark")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(.white)
                            .padding(10)
                            .background(.black.opacity(0.4))
                            .clipShape(Circle())
                            .frame(minWidth: 44, minHeight: 44) // HIG tap target
                            .contentShape(Rectangle())
                    }
                    .accessibilityIdentifier("lightbox-close")
                    .accessibilityLabel("Close")
                    .padding(.trailing, 16).padding(.top, 8)
                }
                Spacer()
            }
        }
        .accessibilityIdentifier("image-lightbox")
        .onTapGesture { onDismiss() }
    }

    private var zoomGesture: some Gesture {
        MagnificationGesture()
            .onChanged { value in
                scale = min(max(lastScale * value, minScale), maxScale)
            }
            .onEnded { _ in
                lastScale = scale
                if scale <= minScale { withAnimation(.easeOut(duration: 0.2)) { resetPan() } }
            }
    }

    private var panGesture: some Gesture {
        DragGesture()
            .onChanged { value in
                offset = CGSize(width: lastOffset.width + value.translation.width,
                                height: lastOffset.height + value.translation.height)
            }
            .onEnded { _ in lastOffset = offset }
    }

    /// At rest (not zoomed), a downward drag fades + dismisses (swipe-down to close).
    private var dismissGesture: some Gesture {
        DragGesture()
            .onChanged { value in dismissDrag = max(0, value.translation.height) }
            .onEnded { value in
                if value.translation.height > 120 { onDismiss() }
                else { withAnimation(.easeOut(duration: 0.2)) { dismissDrag = 0 } }
            }
    }

    private func toggleZoom() {
        withAnimation(.easeOut(duration: 0.2)) {
            if scale > minScale { resetPan() } else { scale = 2.5; lastScale = 2.5 }
        }
    }

    private func resetPan() {
        scale = minScale; lastScale = minScale
        offset = .zero; lastOffset = .zero
    }
}
