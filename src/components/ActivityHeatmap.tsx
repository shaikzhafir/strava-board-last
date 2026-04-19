import { useMemo, useState } from "react";
import type { DailyActivityMap } from "../lib/api";

interface Props {
  map: DailyActivityMap;
}

interface Cell {
  date: string;
  day: number;
  distance_m: number;
  count: number;
  inYear: boolean;
  future: boolean;
}

interface Tip {
  x: number;
  y: number;
  text: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function tierForDistance(distance_m: number): 0 | 1 | 2 | 3 | 4 {
  if (distance_m <= 0) return 0;
  if (distance_m < 5_000) return 1;
  if (distance_m < 15_000) return 2;
  if (distance_m < 30_000) return 3;
  return 4;
}

function formatKm(distance_m: number): string {
  const km = distance_m / 1000;
  return km >= 10 ? km.toFixed(0) : km.toFixed(1);
}

function formatDateLong(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  return dt.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function tipText(cell: Cell): string {
  if (!cell.inYear || cell.future) return "";
  const when = formatDateLong(cell.date);
  if (cell.count === 0) return `No activity on ${when}`;
  const noun = cell.count === 1 ? "activity" : "activities";
  return `${cell.count} ${noun} · ${formatKm(cell.distance_m)} km on ${when}`;
}

function buildWeeks(year: number, byDate: Record<string, { count: number; distance_m: number }>): Cell[][] {
  const start = new Date(year, 0, 1);
  const end = new Date(year, 11, 31);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const firstWeekStart = new Date(start);
  firstWeekStart.setDate(firstWeekStart.getDate() - firstWeekStart.getDay());

  const weeks: Cell[][] = [];
  let cursor = new Date(firstWeekStart);
  while (cursor <= end || cursor.getDay() !== 0) {
    const week: Cell[] = [];
    for (let i = 0; i < 7; i++) {
      const iso = isoDate(cursor);
      const bucket = byDate[iso];
      const inYear = cursor.getFullYear() === year;
      week.push({
        date: iso,
        day: cursor.getDay(),
        distance_m: bucket?.distance_m ?? 0,
        count: bucket?.count ?? 0,
        inYear,
        future: cursor > today,
      });
      cursor = new Date(cursor.getTime() + DAY_MS);
    }
    weeks.push(week);
    if (cursor > end && cursor.getDay() === 0) break;
  }
  return weeks;
}

function monthLabels(weeks: Cell[][]): { label: string; col: number }[] {
  const labels: { label: string; col: number }[] = [];
  let lastMonth = -1;
  weeks.forEach((week, col) => {
    const firstInYear = week.find((c) => c.inYear);
    if (!firstInYear) return;
    const month = Number(firstInYear.date.slice(5, 7)) - 1;
    if (month !== lastMonth) {
      if (col > 0 || labels.length === 0) labels.push({ label: MONTH_NAMES[month], col });
      lastMonth = month;
    }
  });
  // Drop the leading label if the first "new month" column is too close to the
  // second one (happens when Jan 1 falls on a Sunday — the label would overlap).
  if (labels.length >= 2 && labels[1].col - labels[0].col < 3) labels.shift();
  return labels;
}

export default function ActivityHeatmap({ map }: Props) {
  const years = map.years.length > 0 ? map.years : [new Date().getFullYear()];
  const [year, setYear] = useState<number>(years[years.length - 1]);
  const [tip, setTip] = useState<Tip | null>(null);

  const { weeks, months, total, activeDays } = useMemo(() => {
    const weeks = buildWeeks(year, map.byDate);
    const months = monthLabels(weeks);
    let total = 0;
    let activeDays = 0;
    for (const w of weeks) {
      for (const c of w) {
        if (c.inYear && c.count > 0) {
          total += c.distance_m;
          activeDays += 1;
        }
      }
    }
    return { weeks, months, total, activeDays };
  }, [year, map.byDate]);

  const showTip = (
    e: React.MouseEvent<HTMLDivElement> | React.FocusEvent<HTMLDivElement>,
    text: string,
  ) => {
    if (!text) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setTip({
      x: rect.left + rect.width / 2,
      y: rect.top,
      text,
    });
  };
  const hideTip = () => setTip(null);

  return (
    <div className="heatmap">
      <div className="heatmap-head">
        <div>
          <h3 className="heatmap-title">
            {activeDays} active days in {year}
          </h3>
          <p className="heatmap-sub">
            {(total / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })} km total
          </p>
        </div>
        {years.length > 1 && (
          <div className="heatmap-years" role="tablist" aria-label="Select year">
            {[...years].reverse().map((y) => (
              <button
                key={y}
                role="tab"
                aria-selected={y === year}
                className={`heatmap-year${y === year ? " active" : ""}`}
                onClick={() => setYear(y)}
              >
                {y}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="heatmap-scroll">
        <div className="heatmap-inner">
          <div className="heatmap-months">
            {months.map((m, i) => (
              <span
                key={`${m.label}-${i}`}
                className="heatmap-month"
                style={{ gridColumn: m.col + 1 }}
              >
                {m.label}
              </span>
            ))}
          </div>
          <div className="heatmap-body">
            <div className="heatmap-days" aria-hidden="true">
              <span style={{ gridRow: 2 }}>Mon</span>
              <span style={{ gridRow: 4 }}>Wed</span>
              <span style={{ gridRow: 6 }}>Fri</span>
            </div>
            <div
              className="heatmap-grid"
              style={{ gridTemplateColumns: `repeat(${weeks.length}, 11px)` }}
              onMouseLeave={hideTip}
            >
              {weeks.map((week, col) =>
                week.map((cell, row) => {
                  const tier = cell.inYear && !cell.future ? tierForDistance(cell.distance_m) : 0;
                  const hidden = !cell.inYear;
                  const text = tipText(cell);
                  return (
                    <div
                      key={cell.date}
                      className={`heatmap-cell tier-${tier}${hidden ? " hidden" : ""}${
                        cell.future ? " future" : ""
                      }`}
                      style={{ gridColumn: col + 1, gridRow: row + 1 }}
                      onMouseEnter={(e) => showTip(e, text)}
                      onFocus={(e) => showTip(e, text)}
                      onBlur={hideTip}
                      tabIndex={hidden || cell.future ? -1 : 0}
                      aria-label={text || undefined}
                    />
                  );
                }),
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="heatmap-legend">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((t) => (
          <span key={t} className={`heatmap-cell tier-${t}`} aria-hidden="true" />
        ))}
        <span>More</span>
      </div>

      {tip && (
        <div
          className="heatmap-tip"
          role="tooltip"
          style={{ left: `${tip.x}px`, top: `${tip.y}px` }}
        >
          {tip.text}
        </div>
      )}
    </div>
  );
}
