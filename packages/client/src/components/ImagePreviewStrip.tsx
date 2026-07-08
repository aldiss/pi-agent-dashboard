// ---------------------------------------------------------------------------
// ImagePreviewStrip — error banner + image thumbnail grid with remove-X.
//
// Shared between CommandInput and the OpenSpec Explore dialog. Accepts
// the state produced by useImagePaste; emits a remove callback per
// thumbnail. Clicking a thumbnail opens the ImageLightbox overlay just
// like CommandInput did before the extraction.
//
// The component renders NOTHING when there are no images and no error —
// safe to place unconditionally in any container.
// ---------------------------------------------------------------------------

import React, { useState } from "react";
import { Icon } from "@mdi/react";
import { mdiClose, mdiArrowCollapse, mdiImageSizeSelectLarge } from "@mdi/js";
import type { ImageContent } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { ImageLightbox } from "./ImageLightbox.js";
import { useSendFullResolution } from "../hooks/useSendFullResolution.js";
import { IMAGE_MAX_LONG_EDGE } from "../lib/image-resize.js";

interface Props {
	images: ImageContent[];
	error: string | null;
	onRemove: (index: number) => void;
}

export function ImagePreviewStrip({ images, error, onRemove }: Props) {
	const [lightboxSrc, setLightboxSrc] = useState<{ src: string; alt: string } | null>(null);
	const [fullRes, setFullRes] = useSendFullResolution();

	if (images.length === 0 && !error) return null;

	return (
		<>
			{error && (
				<div className="mb-2 text-xs text-red-400 bg-red-900/20 px-3 py-1 rounded">
					{error}
				</div>
			)}
			{images.length > 0 && (
				<div className="mb-2 flex gap-2 flex-wrap">
					{images.map((img, i) => (
						<div key={i} className="relative group">
							<img
								src={`data:${img.mimeType};base64,${img.data}`}
								alt={`Attachment ${i + 1}`}
								className="h-16 w-16 object-cover rounded border border-[var(--border-secondary)] cursor-pointer"
								onClick={() =>
									setLightboxSrc({
										src: `data:${img.mimeType};base64,${img.data}`,
										alt: `Attachment ${i + 1}`,
									})
								}
							/>
							<button
								onClick={() => onRemove(i)}
								className="absolute -top-1 -right-1 w-5 h-5 bg-red-600 rounded-full text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
								title="Remove image"
							>
								<Icon path={mdiClose} size={0.45} />
							</button>
						</div>
					))}
				</div>
			)}
			{images.length > 0 && (
				<button
					type="button"
					onClick={() => setFullRes(!fullRes)}
					data-testid="send-full-resolution-toggle"
					aria-pressed={fullRes}
					title={
						fullRes
							? "Sending full-resolution originals — larger payload, more context used."
							: `Images are downscaled to ${IMAGE_MAX_LONG_EDGE}px on the long edge before sending to save context. Click to send full resolution.`
					}
					className={`mb-2 inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] transition-colors ${
						fullRes
							? "border-[var(--accent)] text-[var(--accent)]"
							: "border-[var(--border-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
					}`}
				>
					<Icon path={fullRes ? mdiImageSizeSelectLarge : mdiArrowCollapse} size={0.5} />
					{fullRes ? "Full resolution" : `Resized to ${IMAGE_MAX_LONG_EDGE}px`}
				</button>
			)}
			{lightboxSrc && (
				<ImageLightbox
					src={lightboxSrc.src}
					alt={lightboxSrc.alt}
					onClose={() => setLightboxSrc(null)}
				/>
			)}
		</>
	);
}
