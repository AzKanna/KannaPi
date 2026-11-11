import type { CSSProperties } from "react";
import { THINKING_LEVELS, type ThinkingLevel } from "@kanna/shared";
import "./thinking-level-slider.css";

const LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Balanced",
  high: "High",
  xhigh: "Extra",
  max: "Maximum",
};

export function ThinkingLevelSlider({
  value,
  levels = [...THINKING_LEVELS],
  disabled = false,
  compact = false,
  label = "Thinking strength",
  onChange,
}: {
  value: ThinkingLevel;
  levels?: ThinkingLevel[];
  disabled?: boolean;
  compact?: boolean;
  label?: string;
  onChange(value: ThinkingLevel): void;
}) {
  const available: ThinkingLevel[] = levels.length ? levels : ["off"];
  const current: ThinkingLevel = available.includes(value) ? value : (available[0] ?? "off");
  const index = Math.max(0, available.indexOf(current));
  const progress = available.length > 1 ? (index / (available.length - 1)) * 100 : 0;

  return <label className={`thinking-level ${compact ? "compact" : ""} ${disabled ? "disabled" : ""}`}>
    <span className="thinking-level-heading"><span>{label}</span><b>{LABELS[current]}</b></span>
    <input
      type="range"
      min="0"
      max={Math.max(0, available.length - 1)}
      step="1"
      value={index}
      disabled={disabled || available.length < 2}
      aria-label={label}
      aria-valuetext={LABELS[current]}
      style={{ "--thinking-progress": `${progress}%` } as CSSProperties}
      onChange={(event) => onChange(available[Number(event.target.value)] ?? current)}
    />
    {!compact && <span className="thinking-level-scale" aria-hidden="true">
      {available.map((level) => <i key={level}>{LABELS[level]}</i>)}
    </span>}
  </label>;
}
