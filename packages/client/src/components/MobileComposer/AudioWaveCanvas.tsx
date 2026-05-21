import { useEffect, useRef } from "react";

interface Props {
  /** Analyser node from useAudioWave hook; null when not recording. */
  analyser: AnalyserNode | null;
  width?: number;
  height?: number;
  /** Bar fill color; default white at 80% opacity (matches ChatGPT iOS recording UX). */
  barColor?: string;
  barCount?: number;
}

/**
 * W12: Canvas-based real-time audio wave visualization (per scout §4.6 verbatim).
 *
 * Renders 32 vertical bars whose heights track real-time frequency data from the
 * AnalyserNode. Uses requestAnimationFrame at native rate; bars are 3px wide with 2px
 * gaps + min-height 4px so silence still shows a baseline. devicePixelRatio-scaled
 * canvas for sharp Retina rendering.
 *
 * Pause-on-detach: when analyser is null (recording stopped), draw loop is cancelled
 * + canvas cleared. Consumer should freeze the canvas content via CSS opacity transition
 * if they want a "frozen wave" effect during the uploading state.
 */
export function AudioWaveCanvas({
  analyser,
  width = 320,
  height = 40,
  barColor = "rgba(255,255,255,0.8)",
  barCount = 32,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!analyser || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const bufLen = analyser.frequencyBinCount;
    const data = new Uint8Array(bufLen);
    const barWidth = 3;
    const gap = 2;
    const totalBarSpace = barWidth + gap;
    const visibleBars = Math.min(barCount, Math.floor(width / totalBarSpace));
    const step = Math.floor(bufLen / visibleBars);

    const draw = () => {
      analyser.getByteFrequencyData(data);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = barColor;
      const totalWidth = visibleBars * totalBarSpace;
      const offsetX = (width - totalWidth) / 2;
      for (let i = 0; i < visibleBars; i++) {
        const value = data[i * step] ?? 0;
        const barHeight = Math.max(4, (value / 255) * height);
        const x = offsetX + i * totalBarSpace;
        const y = (height - barHeight) / 2;
        ctx.fillRect(x, y, barWidth, barHeight);
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(rafRef.current);
  }, [analyser, width, height, barColor, barCount]);

  return <canvas ref={canvasRef} style={{ width, height, display: "block" }} aria-hidden="true" />;
}
