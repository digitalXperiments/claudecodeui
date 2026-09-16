type SparklineProps = { values?: number[]; label?: string };

/** Small, dependency-free health trend used in the roster. */
export default function Sparkline({ values = [], label = 'Recent bot health trend' }: SparklineProps) {
  const points = values.length ? values : [0, 1, 0.6, 1.1, 1];
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const range = max - min || 1;
  const d = points.map((value, index) => `${index ? 'L' : 'M'} ${(index / Math.max(points.length - 1, 1)) * 42} ${14 - ((value - min) / range) * 12}`).join(' ');
  return <svg viewBox="0 0 42 16" className="h-4 w-11 text-primary" role="img" aria-label={label}><path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}
