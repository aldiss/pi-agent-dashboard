import { useState, useRef, useCallback, useEffect, type ChangeEvent, type KeyboardEvent } from "react";
import { Icon } from "@mdi/react";
import { mdiArrowUp, mdiStop, mdiAlert, mdiPlus } from "@mdi/js";
import type { CommandInfo, ImageContent, FileEntry } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { useImagePaste } from "../../hooks/useImagePaste.js";
import { ImagePreviewStrip } from "../ImagePreviewStrip.js";
import { PushToTalkButton } from "@blackbelt-technology/pi-dashboard-voice-input-plugin/client";
import { useAudioWave } from "./useAudioWave.js";
import { AudioWaveCanvas } from "./AudioWaveCanvas.js";

/**
 * W12 (Phase 1 MVP): MobileComposer — ChatGPT-iOS-style mobile composer card with
 * big circular send button + audio-wave visualization during voice recording + sleek dark
 * palette per pi-dashboard baseline (#0a0a0a page → #1a1a1a card → #2a2a2a textarea).
 *
 * Carrier per Q2 ratified-allow selective component fork. Activated by CommandInput.tsx
 * when `useMobile() === true` (touch-primary device) OR `isCapacitorNative() === true`
 * (Phase 2 Capacitor shell).
 *
 * Scope per QuickJaguar's pre-resolved LIGHTER brand-emulation lean (NOT ChatGPT-green):
 * white send button (text-present state) / ghost-state (text-empty); pi-dashboard accent
 * shades; ChatGPT-pattern adoption (big button + audio-wave + multiline-fluid typing) but
 * NOT ChatGPT-color adoption — preserves pi distinct identity.
 *
 * Phase 1 MVP scope-cut (deferred to Phase 1.1 if operator empirical surfaces friction):
 * - Command autocomplete (`/command` dropdown) — desktop-only via CommandInput
 * - File autocomplete (`@file` dropdown) — desktop-only via CommandInput
 * - History recall (up/down arrows) — desktop-only via CommandInput
 *
 * Composes with W2 safe-area + W3 --keyboard-h + W8 16px font-size + r11 PushToTalkButton
 * inline-error + r12 timeout-bump + r13 parakeet load fix (all preserved).
 */

interface Props {
  /** Controlled draft text. When provided, parent controls the textarea via onDraftChange. */
  draft?: string;
  onDraftChange?: (text: string) => void;
  /** Send the current message + images. */
  onSend: (text: string, images?: ImageContent[]) => void;
  /** True while a streaming response is in progress (Send button → Stop button transition). */
  isWorking?: boolean;
  /** Abort the current streaming response. */
  onAbort?: () => void;
  /** True if the entire composer should be disabled (auth required, session ended, etc.). */
  disabled?: boolean;
  /** Optional list of attached images (parent-controlled). */
  images?: ImageContent[];
  /** Called when an image is added/removed from the strip. */
  onImagesChange?: (images: ImageContent[]) => void;
  /** Optional list helpers (currently unused in MVP; kept for type-compatibility). */
  commands?: CommandInfo[];
  onListFiles?: (query: string) => Promise<FileEntry[]>;
  /**
   * r27 Phase 1.1.1 (operator-direct pose-shift 2026-05-18 ~09:30 CEST via QuickKnight relay,
   * Pattern 87 typos `thinkinkg`+`snd`+`to to` PRESERVED: "if agent is thinkinkg, I am not able
   * to to send a mesage in the queue - the snd button then just becomes a thinking button..").
   * Optimistic count of messages queued for the agent's next-turn pickup (incremented when
   * user sends while isWorking=true; reset by parent on session streaming→idle transition).
   * Backend queue is FREE — pi-bridge `command-handler.ts` already uses `deliverAs: "followUp"`
   * for queue-while-streaming; this prop just surfaces the count to the badge UI.
   */
  queuedCount?: number;
}

export function MobileComposer({
  draft,
  onDraftChange,
  onSend,
  isWorking = false,
  onAbort,
  disabled = false,
  images: imagesProp,
  onImagesChange,
  queuedCount = 0,
}: Props) {
  // Text state — controlled or uncontrolled per CommandInput convention
  const isControlled = draft !== undefined;
  const [localText, setLocalText] = useState("");
  const text = isControlled ? (draft as string) : localText;
  const setText = useCallback(
    (v: string) => {
      if (!isControlled) setLocalText(v);
      onDraftChange?.(v);
    },
    [isControlled, onDraftChange],
  );

  // r22 Image-attach scope-add per operator-direct: hidden file input + tap-to-trigger.
  // Pattern 87 operator quote PRESERVED (typos `exolained` + `unuserfirendly` + `i'mon`):
  // "for the pictures - this kind of very unuserfirendly - the way you exolained how to do
  // it . i just want to attach a picture in the chat when i'mon iphone and it works -
  // make this a new feature please". Uses native iOS picker (photo library + camera) via
  // standard `<input type="file">`; no `capture="environment"` so user can choose library OR
  // camera (iOS shows the bottom-sheet picker with both options). Multiple-image select OK.
  //
  // r25 EMERGENCY BUGFIX (mobile white-screen on session-open per operator empirical 2026-05-18
  // ~05:33 CEST via DarkDragon Joan-tenure-18 escalation): the openImagePicker + onFileInputChange
  // callbacks were declared HERE (above useImagePaste destructuring) but `onFileInputChange`
  // referenced `handleFiles` (destructured from useImagePaste BELOW) in its dependency array.
  // JavaScript `const` declarations are NOT hoisted with their values — accessing them before
  // initialization throws TDZ (ReferenceError: Cannot access 'handleFiles' before initialization).
  // The minified bundle name was `O`; root-cause traced via r24 diagnostic shell. Fix: move
  // `fileInputRef` declaration to stay here (no deps); move `openImagePicker` + `onFileInputChange`
  // to AFTER the useImagePaste destructuring so all referenced `const`s exist at that point.
  const fileInputRef = useRef<HTMLInputElement>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow textarea on text change (composes with W3 r11 fix shape).
  // r21 BUGFIX (operator empirical 2026-05-17, Pattern 87 typos `proprtions`+`frim` PRESERVED:
  // "on iphone 14 pro max proprtions of the typing screen is not correct / you have like
  // two lines frim the start.."): empty-textarea-2-line bug on iPhone 14 Pro Max. Root cause:
  // when text is empty, `ta.scrollHeight` measurement on iOS Safari can return > 40px due to
  // computed line-height + padding + Dynamic Type interactions; previous unconditional
  // `Math.min(scrollHeight, 120)` then set height beyond the 40px minimum. Fix: short-circuit
  // when text is empty (no scrollHeight measurement needed; CSS minHeight 40px floor applies).
  // When non-empty, use `auto` reset (cleaner than 40px reset) to get accurate intrinsic
  // scrollHeight, then clamp [40, 120].
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    if (text.length === 0) {
      ta.style.height = "36px";
      return;
    }
    ta.style.height = "auto";
    ta.style.height = Math.min(Math.max(36, ta.scrollHeight), 120) + "px";
  }, [text]);

  // Recording-stream subscription: PushToTalkButton fires onStreamChange when MediaStream
  // becomes available (recording starts) and null when recording stops. useAudioWave
  // attaches an AnalyserNode to the stream; AudioWaveCanvas renders bars on rAF tick.
  const [recordingStream, setRecordingStream] = useState<MediaStream | null>(null);
  const analyserRef = useAudioWave(recordingStream);
  const isRecording = recordingStream !== null;

  // Image paste hook (controlled when imagesProp + onImagesChange; uncontrolled fallback otherwise)
  const { pendingImages, imageError, handlePaste, handleFiles, removeImage, clearImages } = useImagePaste(
    imagesProp,
    onImagesChange,
  );

  // r25 EMERGENCY BUGFIX continued: openImagePicker + onFileInputChange MOVED HERE (was above
  // useImagePaste destructuring — TDZ on handleFiles). Now declared AFTER handleFiles exists.
  const openImagePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);
  const onFileInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      handleFiles(e.target.files);
      // Reset value so the same image can be picked twice in a row
      e.target.value = "";
    },
    [handleFiles],
  );

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed && pendingImages.length === 0) return;
    onSend(trimmed, pendingImages.length > 0 ? pendingImages : undefined);
    setText("");
    clearImages();
    // Reset textarea height after send
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) ta.style.height = "36px";
    });
  }, [text, pendingImages, onSend, setText, clearImages]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Mobile-touch UX: Enter inserts newline (NEVER sends); user must tap Send button.
      // Matches Termina1's 6a73b92a desktop behavior already (Enter-only-on-desktop).
      // No-op here; let default Enter behavior produce newline.
      void e;
    },
    [],
  );

  const handleTranscript = useCallback(
    (transcript: string) => {
      const sep = text && !text.endsWith(" ") && !text.endsWith("\n") ? " " : "";
      setText(text + sep + transcript);
      // Auto-grow handled by useEffect on text change (composes with r11 fix shape)
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [text, setText],
  );

  // r27 Phase 1.1.1: canSend NO LONGER blocks on isWorking — user can tap Send while agent is
  // streaming; backend queues via deliverAs: "followUp" (pi-bridge command-handler.ts:505).
  // Stop button becomes ADDITIONAL (renders alongside Send when isWorking), not replacement.
  const canSend = !disabled && (text.trim().length > 0 || pendingImages.length > 0);

  return (
    <div
      className="absolute left-2 right-2 z-10 rounded-3xl backdrop-blur-xl border border-white/10 shadow-2xl p-3"
      style={{
        // W6 (mobile-pwa-chatgpt-style-restructure/v1, MintOwl L2 cell-executor) per Bert tenure-2
        // Q3 W3 verdict 2026-05-20 ~23:55 CEST (RATIFY + sharpening): "backdrop-blur translucent pill
        // is the right pattern. ONE sharpening: with the r30.2 outer container being `position:
        // fixed; inset: 0`, the pill should be `position: absolute` (not nested-fixed) inside that
        // container. Verify the worker resolves the `bottom: env()` shape against the fixed-positioned
        // ancestor cleanly." Composer now floats OVER chat with backdrop-blur + 8px horizontal
        // gutters; chat scrolls behind it per ChatGPT-iOS pattern. Operator-verbatim per Pattern 87
        // (typo `unncessay` PRESERVED): "space should be for the chat, not for unncessay info". The
        // `bottom:` composes safe-area home-indicator clearance with `--keyboard-h` CSS-var from r29
        // (defense-in-depth keyboard-avoidance; canonical T4 + T5 + T7 + T8 from Bert W3 canonical
        // T-list — T4 backdrop-blur pill / T5 chat scrolls behind / T7 r29 preserved / T8 r30.2
        // fixed-inset-0 preserved). Border-t removed per T5 (no separator; chat extends behind).
        //
        // r29 PRESERVED rationale (operator empirical 2026-05-20 ~16:01 CEST via Bert tenure-2 +
        // SwiftIce Joan-tenure-22 per Mega-Cluster M tier-(b); Pattern 87 typos `beleive inasked`
        // PRESERVED): "i am talking specifically about wasted space in the bottom of the form. I
        // beleive inasked Joan to remove it". The `max(0.5rem, env(safe-area-inset-bottom, 0.5rem))`
        // paddingBottom retains the bottom safe-area ownership per MobileShell architecture comment
        // — bottom safe area is OWNED by the composer; MobileShell deliberately does NOT apply it
        // to avoid the Termina1 3df2a0ec double-gap regression. 8px fallback for non-notched devices.
        bottom: "calc(env(safe-area-inset-bottom, 0.5rem) + var(--keyboard-h, 0px))",
        paddingBottom: "max(0.5rem, env(safe-area-inset-bottom, 0.5rem))",
        background: "rgba(20, 20, 20, 0.65)",
      }}
      data-testid="mobile-composer"
    >
      {/* r27 Phase 1.1.1 queue badge — surfaces optimistic queuedCount above composer when > 0.
       *  Tap-to-expand drilldown DEFERRED to Phase 1.5 fuller per operator-ratify-via-QuickKnight
       *  2026-05-18. Sufficient signal for operator to know her queued messages registered. */}
      {queuedCount > 0 && (
        <div
          className="mb-2 text-xs text-[var(--text-secondary)] flex items-center gap-1.5 bg-[var(--bg-tertiary)] rounded-full px-2.5 py-1 self-start inline-flex"
          role="status"
          data-testid="mobile-composer-queue-badge"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" aria-hidden="true" />
          <span>{queuedCount} queued</span>
        </div>
      )}

      {/* Image paste preview strip — above textarea inside the composer */}
      {pendingImages.length > 0 && (
        <ImagePreviewStrip images={pendingImages} onRemove={removeImage} />
      )}
      {imageError && (
        <div className="mb-2 text-xs text-[var(--accent-red)] flex items-center gap-1.5" role="alert">
          <Icon path={mdiAlert} size={0.55} />
          <span>{imageError}</span>
        </div>
      )}

      {/* Composer card: rounded dark card with textarea + buttons.
       *  r22 compression-(a) ratified per operator pick 2026-05-17 "compression menu - default
       *  fine": card padding py-2→py-1.5; minHeight 56→48; textarea minHeight 40→36.
       *  Aggregate ~12px vertical reclaim per QuickKnight scope-option (a) recommendation. */}
      <div
        className="bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-3xl px-3 py-1.5 flex items-end gap-2 shadow-lg"
        style={{ minHeight: 48 }}
      >
        {/* r22 Image-attach button (operator-direct scope-add 2026-05-17). Tap opens iOS native
         *  photo picker (library + camera options). Hidden <input type="file"> triggered
         *  imperatively for cleaner Tailwind styling. */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          multiple
          onChange={onFileInputChange}
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          data-testid="mobile-composer-file-input"
        />
        <button
          type="button"
          onClick={openImagePicker}
          disabled={disabled}
          aria-label="Attach image"
          title="Attach image"
          className="w-9 h-9 rounded-full bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] active:scale-95 transition-all flex items-center justify-center self-end disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="mobile-composer-attach"
        >
          <Icon path={mdiPlus} size={0.85} />
        </button>

        {/* Text area OR audio wave (when recording, wave replaces textarea visually) */}
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={isRecording ? "" : "Message"}
            disabled={disabled || isRecording}
            rows={1}
            className="w-full bg-transparent text-base text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:outline-none disabled:opacity-50 resize-none"
            style={{ minHeight: "36px", maxHeight: "120px" }}
            data-testid="mobile-composer-textarea"
          />
          {isRecording && (
            <div
              className="absolute inset-0 flex items-center justify-center pointer-events-none"
              aria-hidden="true"
              data-testid="mobile-composer-audio-wave"
            >
              <AudioWaveCanvas analyser={analyserRef.current} width={240} height={40} />
            </div>
          )}
        </div>

        {/* Mic button (PushToTalkButton handles its own state + audio capture + transcribe).
            Subscribes via onStreamChange so MobileComposer renders the audio wave during recording.
            Custom className keeps the button at 40x40 ChatGPT-style + self-end alignment. */}
        <PushToTalkButton
          disabled={disabled}
          onTranscript={handleTranscript}
          onStreamChange={setRecordingStream}
          className="w-10 h-10 rounded-full bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] active:scale-95 transition-all flex items-center justify-center self-end disabled:opacity-50 disabled:cursor-not-allowed"
          idleTitle="Tap to record voice (tap again to stop)"
        />

        {/* r27 Phase 1.1.1: Send + Stop render side-by-side when isWorking (vs pre-r27 Stop-only).
         *  Send button is now ALWAYS rendered (operator can tap-to-queue while agent streams);
         *  Stop button renders ADDITIONALLY when isWorking && onAbort (preserves abort affordance).
         *  Backend handles queue via deliverAs: "followUp" in pi-bridge command-handler.ts. */}
        {isWorking && onAbort && (
          <button
            type="button"
            onClick={onAbort}
            className="w-10 h-10 rounded-full bg-[var(--accent-red)] hover:opacity-90 active:scale-95 transition-all flex items-center justify-center self-end"
            title="Stop"
            data-testid="mobile-composer-stop"
          >
            <Icon path={mdiStop} size={0.7} color="#fff" />
          </button>
        )}
        <button
          type="button"
          onClick={handleSend}
          disabled={!canSend}
          className={`w-10 h-10 rounded-full flex items-center justify-center self-end transition-all active:scale-95 ${
            canSend
              ? "bg-white hover:opacity-90"
              : "bg-[var(--bg-tertiary)] cursor-not-allowed"
          }`}
          title={isWorking ? "Queue message for next turn" : "Send"}
          data-testid="mobile-composer-send"
        >
          <Icon
            path={mdiArrowUp}
            size={0.85}
            color={canSend ? "#000" : "var(--text-tertiary)"}
          />
        </button>
      </div>
    </div>
  );
}
