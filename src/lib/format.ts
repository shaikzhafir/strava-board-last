export function metersToKm(m: number): string {
  return (m / 1000).toFixed(2);
}

export function metersToMi(m: number): string {
  return (m / 1609.344).toFixed(2);
}

export function secondsToDuration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// Pace in min/km from meters-per-second average speed.
export function paceMinPerKm(speedMps: number): string {
  if (!speedMps || speedMps <= 0) return "—";
  const secPerKm = 1000 / speedMps;
  const m = Math.floor(secPerKm / 60);
  const s = Math.floor(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}/km`;
}

// Numeric pace (min/km) for charts.
export function paceMinPerKmNumeric(speedMps: number): number {
  if (!speedMps || speedMps <= 0) return 0;
  return 1000 / speedMps / 60;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
