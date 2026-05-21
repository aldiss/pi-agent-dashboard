import { useEffect, useRef } from "react";

/**
 * W12: WebAudio AnalyserNode hook for real-time audio visualization during voice recording.
 *
 * Given a MediaStream (from getUserMedia in PushToTalkButton.tsx), creates an AudioContext +
 * AnalyserNode and returns a ref to the analyser. Consumers (AudioWaveCanvas) read frequency
 * data via `analyser.getByteFrequencyData()` on every requestAnimationFrame tick.
 *
 * Lifecycle: AudioContext + MediaStreamSource created on stream attach; closed on stream
 * detach or unmount. fftSize=256 → 128 frequency bins → ~32 visible bars after halving.
 * smoothingTimeConstant=0.5 = moderate temporal smoothing (avoids jittery bars).
 *
 * Returns ref-to-analyser-or-null (NOT analyser directly) so consumers re-render only when
 * they want to, not when ref reassigns. Per scout §4.5 verbatim.
 */
export function useAudioWave(stream: MediaStream | null) {
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (!stream) {
      analyserRef.current = null;
      return;
    }
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);
    audioCtxRef.current = ctx;
    analyserRef.current = analyser;
    return () => {
      try {
        source.disconnect();
      } catch {
        /* defensive */
      }
      ctx.close().catch(() => {});
      analyserRef.current = null;
      audioCtxRef.current = null;
    };
  }, [stream]);

  return analyserRef;
}
