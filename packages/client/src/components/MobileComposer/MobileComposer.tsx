import { useState, useRef, useCallback, useEffect, type ChangeEvent, type KeyboardEvent } from "react";
import { Icon } from "@mdi/react";
import { mdiArrowUp, mdiStop, mdiAlert, mdiPlus } from "@mdi/js";
import type { CommandInfo, ImageContent, FileEntry } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { useImagePaste } from "../../hooks/useImagePaste.js";
import { ImagePreviewStrip } from "../ImagePreviewStrip.js";
import { PushToTalkButton } from "@blackbelt-technology/pi-dashboard-voice-input-plugin/client";
import { useAudioWave } from "./useAudioWave.js";
import { AudioWaveCanvas } from "./AudioWaveCanvas.js";
import { haptic, Pressable } from "../../motion/index.js";

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
  /** Send the current message + images. Returns whether the caller should clear
   *  the draft: the Dawn preview-before-Send flow returns false on spool failure
   *  so the visible text + pending capture are preserved. void/undefined (e2e
   *  harness) clears as before. */
  onSend: (text: string, images?: ImageContent[]) => void | boolean | Promise<void | boolean>;
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
  /**
   * Dawn parity: the parent (CommandInput) owns the Dawn-aware transcript
   * handler and the Dawn audio capture. MobileComposer reuses them via these
   * callback props rather than reimplementing the spool call — there is exactly
   * one spool implementation, in CommandInput. When absent (the isolated e2e
   * harness), MobileComposer falls back to appending the raw transcript.
   */
  onVoiceTranscript?: (transcript: string) => void;
  /** Dawn audio capture. Receives the same MediaStream the waveform uses. */
  onDawnStreamChange?: (stream: MediaStream | null) => void;
  /** Fail-closed mic-block: true while a Dawn dictation is pending-unsent, so no
   *  new recording can start until the pending one is sent or explicitly cleared. */
  micBlocked?: boolean;
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
  onVoiceTranscript,
  onDawnStreamChange,
  micBlocked = false,
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

  // r31 ADAPTIVE layout (operator-direct: ChatGPT single-row ⇄ column). EMPTY/single-line →
  // COMPACT SINGLE ROW (attach | textarea flex-1 | mic/stop/send inline) keeps the composer
  // short; MULTILINE (2+ lines) → COLUMN (textarea full-width on top, attach left / controls
  // right on a row below). Decided in the auto-grow effect via asymmetric HYSTERESIS so a
  // borderline-wrapping message does not flip-flop every keystroke (the single-row textarea is
  // narrow ~26ch/line; the column textarea is wide ~43ch/line — a re-measure after the flip
  // would otherwise oscillate). One stable element tree toggles classNames only (no remount →
  // no focus loss); see the card JSX below.
  const [isMultiline, setIsMultiline] = useState(false);

  // Auto-grow textarea on text change (composes with W3 r11 fix shape).
  // r21 BUGFIX (operator empirical 2026-05-17, Pattern 87 typos `proprtions`+`frim` PRESERVED:
  // "on iphone 14 pro max proprtions of the typing screen is not correct / you have like
  // two lines frim the start.."): empty-textarea-2-line bug on iPhone 14 Pro Max. Root cause:
  // when text is empty, `ta.scrollHeight` measurement on iOS Safari can return > 40px due to
  // computed line-height + padding + Dynamic Type interactions; previous unconditional
  // `Math.min(scrollHeight, 120)` then set height beyond the 40px minimum. Fix: short-circuit
  // when text is empty (no scrollHeight measurement needed; CSS minHeight 40px floor applies).
  // When non-empty, use `auto` reset (cleaner than 40px reset) to get accurate intrinsic
  // scrollHeight, then clamp [36, 200].
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    if (text.length === 0) {
      ta.style.height = "36px";
      setIsMultiline(false);
      return;
    }
    ta.style.height = "auto";
    const sh = ta.scrollHeight;
    ta.style.height = Math.min(Math.max(36, sh), 200) + "px";
    // HYSTERESIS (TRAP 1): go column on an explicit newline OR (while still single-row) a wrap
    // past the ~45px scrollHeight threshold — but only once the text is long enough to commit
    // (>20 chars). Once column, STAY column by LENGTH ALONE (no width-derived re-measure) until
    // the text is short (≤20, no newline) or cleared. Entry-floor and revert-floor share 20, so
    // there is no unstable pocket: on this real geometry the single-row textarea is very narrow
    // (~136px → wraps at ~len 18), BELOW 20; gating entry by >20 (and dropping the `sh>45`
    // re-measure from the stay branch) is what kills the per-keystroke flip-flop the naive
    // sh-only formula hits (brief-mandated "engineer around the trap"; constants 45/20 preserved).
    const hasNewline = text.includes("\n");
    setIsMultiline((prev) =>
      hasNewline ? true : prev ? text.length > 20 : sh > 45 && text.length > 20,
    );
  }, [text]);

  // Re-measure height after a single-row ⇄ column flip. The two layouts render the textarea at
  // different widths (single-row is narrow, ~26ch/line; column is full-width, ~43ch/line), so a
  // height computed at the pre-flip width is stale once the layout changes. The auto-grow effect
  // above depends on [text] ONLY — a one-shot insertion that triggers the flip (voice dictation
  // lands a whole transcript at once via handleTranscript, with no follow-up keystroke to re-run
  // it) would otherwise leave the box sized for the narrow single-row width: too tall for the
  // now-wide column, i.e. phantom "extra enter" blank rows. Height-only re-measure at the new
  // width; does NOT touch the isMultiline decision (no setState → no loop).
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta || text.length === 0) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(Math.max(36, ta.scrollHeight), 200) + "px";
  }, [isMultiline]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // Success haptic on send (real on Capacitor/Android; silent no-op on iOS
    // Safari). The optimistic bubble lift in ChatView is the visual half of the
    // same beat — together they make send feel acknowledged, instantly.
    haptic("success");
    // Await the parent-owned submit and clear ONLY on success. The Dawn
    // preview-before-Send flow returns false on spool failure, preserving the
    // exact visible text + pending audio; void/undefined (harness) clears.
    void (async () => {
      const ok = await onSend(trimmed, pendingImages.length > 0 ? pendingImages : undefined);
      if (ok === false) return;
      setText("");
      clearImages();
      // Reset textarea height after send
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) ta.style.height = "36px";
      });
    })();
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
      // Reuse the parent's Dawn-aware handler when wired (production path): it
      // routes a Dawn dictation to /spool and appends the entry path, and a
      // non-Dawn dictation to a raw append, via the SAME shared draft this
      // composer reads. Only fall back to a local raw append when the parent
      // did not wire it (the isolated e2e harness).
      if (onVoiceTranscript) {
        onVoiceTranscript(transcript);
        requestAnimationFrame(() => textareaRef.current?.focus());
        return;
      }
      const sep = text && !text.endsWith(" ") && !text.endsWith("\n") ? " " : "";
      setText(text + sep + transcript);
      // Auto-grow handled by useEffect on text change (composes with r11 fix shape)
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [text, setText, onVoiceTranscript],
  );

  // Stream lifecycle: the waveform AND the parent's Dawn audio capture must
  // receive the SAME MediaStream. PushToTalkButton fires this once with the
  // stream (recording starts) and once with null (stops); both consumers see
  // both edges.
  const handleStreamChange = useCallback(
    (stream: MediaStream | null) => {
      setRecordingStream(stream);
      onDawnStreamChange?.(stream);
    },
    [onDawnStreamChange],
  );

  // r27 Phase 1.1.1: canSend NO LONGER blocks on isWorking — user can tap Send while agent is
  // streaming; backend queues via deliverAs: "followUp" (pi-bridge command-handler.ts:505).
  // Stop button becomes ADDITIONAL (renders alongside Send when isWorking), not replacement.
  const canSend = !disabled && (text.trim().length > 0 || pendingImages.length > 0);

  /* Q3-amendment (Bert tenure-2 mid-cycle verdict 2026-05-21 ~00:35 CEST per operator
   * empirical observation; Pattern 87 verbatim preserved: "composer also should be
   * much closer to the bottom!!!! the same way as it is in chat gpt"):
   *
   * Composer pill BACKGROUND extends to screen bottom (no env(safe-area-inset-bottom)
   * on outer container; bottom: var(--keyboard-h, 0px) hugs screen edge when keyboard
   * down + pushes above keyboard when keyboard up via r29 mechanism preserved).
   * Interactive CONTENT stays above home-indicator via internal padding-bottom:
   * env(safe-area-inset-bottom). Border-radius rounded-t-3xl only (flat bottom fits
   * screen edge OR keyboard top per Apple HIG sister-precedent iMessage pattern).
   *
   * W6-v2 PRIOR shape: bottom: calc(env(safe-area-inset-bottom, 0.5rem) + var(--keyboard-h, 0px))
   *                    + rounded-3xl + p-3 + paddingBottom max(0.5rem, env(safe-area-inset-bottom, 0.5rem))
   * Q3-amendment shape: bottom: var(--keyboard-h, 0px) + rounded-t-3xl + explicit per-side padding
   *                     + paddingBottom max(0.5rem, env(safe-area-inset-bottom, 0.5rem)) preserved
   * Cell: mobile-pwa-chatgpt-style-restructure/v1 (MintOwl L2 cell-executor; W6-v2 stacked on r30.2
   * `8f1af3b4`; Q3-amendment stacks on `75ca2a32` restructure-commit).
   *
   * Keyboard-avoidance composition (cell-executor judgment-call extending Bert spec):
   *   - Bert did NOT specify keyboard handling explicitly; preserving r29 canonical mechanism
   *     (`9cc91427` useKeyboardInsets CSS-var pipeline) is load-bearing for T7 (r29 keyboard-
   *     avoidance preserved).
   *   - `bottom: var(--keyboard-h, 0px)` extends r29: when keyboard down `--keyboard-h = 0` →
   *     composer hugs screen bottom per Bert "no gap" framing; when keyboard up `--keyboard-h
   *     = N px` → composer pushed up by N to sit above keyboard top per iMessage sister-precedent.
   *   - `rounded-t-3xl` flat-bottom corners fit both screen edge (keyboard down) AND keyboard top
   *     (keyboard up); rounded top corners preserve pill identity at top edge.
   *
   * r29 PRESERVED rationale (operator empirical 2026-05-20 ~16:01 CEST via Bert tenure-2 +
   * SwiftIce Joan-tenure-22 per Mega-Cluster M tier-(b); Pattern 87 typos `beleive inasked`
   * PRESERVED): "i am talking specifically about wasted space in the bottom of the form. I
   * beleive inasked Joan to remove it". The `max(0.5rem, env(safe-area-inset-bottom, 0.5rem))`
   * paddingBottom on outer container retains the interactive-content safe-area clearance per
   * Bert Q3 amendment "controls stay finger-reachable" framing; 8px fallback for non-notched
   * devices preserves r29 wasted-space discipline. Bottom safe-area ownership stays with the
   * composer (MobileShell architecture comment unchanged; Termina1 3df2a0ec double-gap
   * regression avoidance preserved). */
  return (
    <div
      className="absolute left-2 right-2 z-10 rounded-t-3xl"
      style={{
        bottom: "var(--keyboard-h, 0px)",
        paddingTop: "0.5rem",
        paddingBottom: "max(0.5rem, env(safe-area-inset-bottom, 0.5rem))",
        paddingLeft: "0.75rem",
        paddingRight: "0.75rem",
        // r30.4 blob-reduction (operator-verbatim 2026-05-21 ~02 CEST via Bert tenure-2 relay,
        // typo PRESERVED per Pattern 87: "this blob around the composer window - why cant we remove it"):
        // Q3-amendment pill outer wrapper was reading as bloated translucent card with visible
        // blur-glow border. Removed `backdrop-blur-xl border border-white/10 shadow-2xl`; switched
        // background from `rgba(20,20,20,0.65)` translucent-blurred to solid `var(--bg-secondary)`.
        // ChatGPT iOS reference pattern: opaque, no halo, no border, no shadow, tight padding.
        // Internal padding (top 0.5rem / sides 0.75rem / bottom max(0.5rem, env())) already tight
        // — no trim warranted per measurement. Q3-amendment shape (bottom: var(--keyboard-h, 0px)
        // + rounded-t-3xl flat-bottom) preserved. r29.1 keyboard-avoidance pipeline preserved.
        background: "var(--bg-secondary)",
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

      {/* Composer card — ONE STABLE TREE, adaptive class-toggle only (TRAP 2: no remount → no
       *  focus loss). EMPTY/single-line → single-row `flex items-end` (attach | textarea flex-1 |
       *  mic/stop/send inline), minHeight 48 keeps the ChatGPT compact pill. MULTILINE → column
       *  `flex flex-wrap items-center`: the textarea wrapper's `order-first basis-full w-full`
       *  forces it onto line 1 full-width, while `attach` and the `ml-auto` controls group wrap to
       *  line 2 (attach left, cluster right). Every interactive element keeps the SAME identity
       *  across the flip; only classNames/order/width change.
       *  r22 compression-(a) ratified per operator pick 2026-05-17: card padding py-1.5/py-2;
       *  minHeight 48 (single-row); textarea minHeight 36. */}
      <div
        className={
          isMultiline
            ? "bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-3xl px-3 py-2 flex flex-wrap items-center gap-2 shadow-lg"
            : "bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-3xl px-3 py-1.5 flex items-end gap-2 shadow-lg"
        }
        style={!isMultiline ? { minHeight: 48 } : undefined}
        data-testid="mobile-composer-card"
        data-multiline={isMultiline ? "true" : "false"}
      >
        {/* r22 Image-attach (operator-direct scope-add 2026-05-17): hidden <input type="file">
         *  opens the iOS native photo picker (library + camera). Triggered imperatively from the
         *  attach button. The hidden input has no visual position — kept at the top of the card. */}
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

        {/* Attach (+) — STABLE first flow child; left in BOTH modes (single-row: between card edge
            and textarea; column: line 2 left). className mode-independent so it never remounts. */}
        <Pressable
          type="button"
          onClick={openImagePicker}
          disabled={disabled}
          aria-label="Attach image"
          title="Attach image"
          className="w-9 h-9 rounded-full bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] transition-colors flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="mobile-composer-attach"
        >
          <Icon path={mdiPlus} size={0.85} />
        </Pressable>

        {/* Textarea wrapper — STABLE single textarea. Single-row: `flex-1` shares the row beside
            the controls. Column: `order-first basis-full w-full` forces it onto line 1 full-width,
            wrapping attach + controls to line 2. Auto-grows downward; the audio-wave overlay still
            absolutely covers it while recording (replaces it visually). */}
        <div className={isMultiline ? "order-first basis-full w-full relative" : "flex-1 relative"}>
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
            style={{ minHeight: "36px", maxHeight: "200px" }}
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

        {/* Right controls group — STABLE. Single-row: `flex items-end` sits inline after the
            textarea. Column: `ml-auto flex items-center` pushes the cluster to the right edge of
            line 2 (attach stays left). mic / stop / send keep identity across the flip. */}
        <div className={isMultiline ? "ml-auto flex items-center gap-2" : "flex items-end gap-2"}>
          {/* Mic button (PushToTalkButton handles its own state + audio capture + transcribe).
              Subscribes via onStreamChange so MobileComposer renders the audio wave during recording.
              Custom className keeps the button at 40x40 ChatGPT-style. */}
          <PushToTalkButton
            disabled={disabled || micBlocked}
            onTranscript={handleTranscript}
            onStreamChange={handleStreamChange}
            className="w-10 h-10 rounded-full bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] active:scale-95 transition-all flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
            idleTitle={micBlocked ? "Send or clear the pending dictation first" : "Tap to record voice (tap again to stop)"}
          />

          {/* r27 Phase 1.1.1: Send + Stop render side-by-side when isWorking (vs pre-r27 Stop-only).
           *  Send button is now ALWAYS rendered (operator can tap-to-queue while agent streams);
           *  Stop button renders ADDITIONALLY when isWorking && onAbort (preserves abort affordance).
           *  Backend handles queue via deliverAs: "followUp" in pi-bridge command-handler.ts. */}
          {isWorking && onAbort && (
            <Pressable
              type="button"
              onClick={onAbort}
              haptic="warning"
              className="w-10 h-10 rounded-full bg-[var(--accent-red)] hover:opacity-90 transition-opacity flex items-center justify-center"
              title="Stop"
              data-testid="mobile-composer-stop"
            >
              <Icon path={mdiStop} size={0.7} color="#fff" />
            </Pressable>
          )}
          <Pressable
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            haptic={false}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
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
          </Pressable>
        </div>
      </div>
    </div>
  );
}
