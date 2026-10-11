import { View } from 'react-native';
import Svg, { Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { usePalette } from './ui';

const lakhs = (paise: number) => {
  const rupees = paise / 100;
  if (Math.abs(rupees) >= 1e7) return `${(rupees / 1e7).toFixed(1)}Cr`;
  if (Math.abs(rupees) >= 1e5) return `${(rupees / 1e5).toFixed(1)}L`;
  if (Math.abs(rupees) >= 1e3) return `${(rupees / 1e3).toFixed(0)}k`;
  return rupees.toFixed(0);
};

/** Line chart of a value over time (e.g. net worth). Values are paise. */
export function LineChart({ points, height = 140 }: { points: Array<{ label: string; value: number }>; height?: number }) {
  const p = usePalette();
  const width = 320;
  if (points.length < 2) return null;
  const values = points.map((x) => x.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 24;
  const xy = points.map((pt, i) => [pad + (i / (points.length - 1)) * (width - pad * 2), pad / 2 + (1 - (pt.value - min) / span) * (height - pad * 1.5)] as const);
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return (
    <View accessibilityLabel={`Chart from ${points[0]!.label} to ${points[points.length - 1]!.label}`}>
      <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}>
        <Line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke={p.border} />
        <Path d={d} stroke={p.accent} strokeWidth={2} fill="none" />
        <SvgText x={pad} y={height - 6} fontSize={10} fill={p.muted}>{points[0]!.label}</SvgText>
        <SvgText x={width - pad} y={height - 6} fontSize={10} fill={p.muted} textAnchor="end">{points[points.length - 1]!.label}</SvgText>
        <SvgText x={width - pad} y={12} fontSize={10} fill={p.muted} textAnchor="end">₹{lakhs(max)}</SvgText>
        <SvgText x={width - pad} y={height - pad - 4} fontSize={10} fill={p.muted} textAnchor="end">₹{lakhs(min)}</SvgText>
      </Svg>
    </View>
  );
}

/** Paired bars per month: income vs spending. */
export function IncomeExpenseBars({ months, height = 150 }: { months: Array<{ label: string; income: number; expense: number }>; height?: number }) {
  const p = usePalette();
  const width = 320;
  const max = Math.max(1, ...months.flatMap((m) => [m.income, m.expense]));
  const slot = (width - 20) / Math.max(1, months.length);
  const barW = Math.max(3, slot / 3);
  const base = height - 18;
  return (
    <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}>
      {months.map((m, i) => {
        const x = 10 + i * slot + slot / 2 - barW;
        const hi = ((base - 8) * m.income) / max;
        const he = ((base - 8) * m.expense) / max;
        return [
          <Rect key={`i${i}`} x={x} y={base - hi} width={barW} height={hi} fill={p.ok} />,
          <Rect key={`e${i}`} x={x + barW} y={base - he} width={barW} height={he} fill={p.danger} />,
          <SvgText key={`t${i}`} x={x + barW} y={height - 4} fontSize={9} fill={p.muted} textAnchor="middle">{m.label}</SvgText>,
        ];
      })}
    </Svg>
  );
}

/** Horizontal share bars (allocation, categories). `share` is 0–1. */
export function ShareBars({ rows }: { rows: Array<{ label: string; share: number; caption: string }> }) {
  const p = usePalette();
  const width = 320;
  const rowH = 26;
  return (
    <Svg width="100%" height={rows.length * rowH} viewBox={`0 0 ${width} ${rows.length * rowH}`}>
      {rows.map((r, i) => [
        <SvgText key={`l${i}`} x={0} y={i * rowH + 12} fontSize={11} fill={p.text}>{r.label}</SvgText>,
        <SvgText key={`c${i}`} x={width} y={i * rowH + 12} fontSize={11} fill={p.muted} textAnchor="end">{r.caption}</SvgText>,
        <Rect key={`b${i}`} x={0} y={i * rowH + 16} width={width} height={6} fill={p.border} rx={3} />,
        <Rect key={`f${i}`} x={0} y={i * rowH + 16} width={Math.max(2, width * Math.min(1, Math.max(0, r.share)))} height={6} fill={p.accent} rx={3} />,
      ])}
    </Svg>
  );
}
