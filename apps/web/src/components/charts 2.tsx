'use client';

import { useState } from 'react';
import type { ChartModel, Datum } from '../lib/visuals';

// Ranked horizontal bars and a line chart (docs/ui/ui-standards.md; marks per the data-viz method):
// one hue, thin marks with a rounded data end, values labelled at the tip with the server's own
// display text, recessive hairlines. Nothing here formats a number.

export function BarChart({
  model,
  onSelect,
}: {
  model: ChartModel;
  onSelect: (evidenceId: string) => void;
}) {
  const max = Math.max(...model.data.map((d) => d.value), 0);
  return (
    <ol className="bars" aria-label={`${model.measureLabel}, ranked`}>
      {model.data.map((d) => (
        <li key={d.evidenceId}>
          <button type="button" className="bar-row" onClick={() => onSelect(d.evidenceId)}>
            <span className="bar-label" title={d.label}>
              {d.label}
            </span>
            <span className="bar-track">
              <span
                className="bar-fill"
                style={{ width: max > 0 ? `${Math.max((d.value / max) * 100, 0.8)}%` : '0%' }}
              />
            </span>
            <span className="bar-value">{d.display}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

const W = 640;
const H = 220;
const PAD = { l: 8, r: 72, t: 16, b: 28 };

export function LineChart({
  model,
  onSelect,
}: {
  model: ChartModel;
  onSelect: (evidenceId: string) => void;
}) {
  const [hover, setHover] = useState<number | undefined>();
  const values = model.data.map((d) => d.value);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const x = (i: number): number => PAD.l + (i / (model.data.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number): number => PAD.t + (1 - (v - min) / span) * (H - PAD.t - PAD.b);
  const pts = model.data.map((d, i) => `${x(i).toFixed(1)},${y(d.value).toFixed(1)}`);
  const last = model.data[model.data.length - 1] as Datum;
  const peak = model.data.reduce((a, b) => (b.value > a.value ? b : a));
  const active = hover === undefined ? undefined : model.data[hover];

  function move(e: React.MouseEvent<SVGSVGElement>): void {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (model.data.length - 1));
    setHover(Math.min(Math.max(i, 0), model.data.length - 1));
  }

  return (
    <div className="line">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${model.measureLabel} over time, from ${model.data[0]?.label} to ${last.label}. The table has every value.`}
        onMouseMove={move}
        onMouseLeave={() => setHover(undefined)}
        onClick={() => active && onSelect(active.evidenceId)}
      >
        {[0, 1, 2, 3].map((g) => (
          <line
            key={g}
            className="grid"
            x1={PAD.l}
            x2={W - PAD.r}
            y1={PAD.t + (g / 3) * (H - PAD.t - PAD.b)}
            y2={PAD.t + (g / 3) * (H - PAD.t - PAD.b)}
          />
        ))}
        <polygon
          className="area"
          points={`${x(0)},${H - PAD.b} ${pts.join(' ')} ${x(model.data.length - 1)},${H - PAD.b}`}
        />
        <polyline className="series" points={pts.join(' ')} />
        <text className="axis-label" x={x(0)} y={H - 8}>
          {model.data[0]?.label}
        </text>
        <text className="axis-label" x={x(model.data.length - 1)} y={H - 8} textAnchor="end">
          {last.label}
        </text>
        {peak.evidenceId !== last.evidenceId && (
          <text
            className="point-label"
            x={x(model.data.indexOf(peak))}
            y={y(peak.value) - 10}
            textAnchor="middle"
          >
            {peak.display}
          </text>
        )}
        <circle className="dot" cx={x(model.data.length - 1)} cy={y(last.value)} r="5" />
        <text className="point-label end" x={x(model.data.length - 1) + 10} y={y(last.value) + 4}>
          {last.display}
        </text>
        {active && hover !== undefined && (
          <>
            <line className="cross" x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} />
            <circle className="dot" cx={x(hover)} cy={y(active.value)} r="5" />
          </>
        )}
      </svg>
      <div className="line-tip" aria-hidden="true">
        {active
          ? `${active.label} · ${active.display}`
          : 'Hover to read a value. Select a point for its source.'}
      </div>
    </div>
  );
}
