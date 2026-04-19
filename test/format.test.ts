import { describe, it, expect } from "vitest";
import {
  metersToKm,
  secondsToDuration,
  paceMinPerKm,
  paceMinPerKmNumeric,
  timeAgo,
} from "../src/lib/format";

describe("format", () => {
  it("metersToKm rounds to 2 decimals", () => {
    expect(metersToKm(5000)).toBe("5.00");
    expect(metersToKm(1234)).toBe("1.23");
  });

  it("secondsToDuration handles hours/minutes/seconds", () => {
    expect(secondsToDuration(45)).toBe("45s");
    expect(secondsToDuration(65)).toBe("1m 5s");
    expect(secondsToDuration(3661)).toBe("1h 1m");
  });

  it("paceMinPerKm formats m/s to min:sec/km", () => {
    // 3.33 m/s ≈ 5:00/km
    expect(paceMinPerKm(1000 / 300)).toBe("5:00/km");
    expect(paceMinPerKm(0)).toBe("—");
  });

  it("paceMinPerKmNumeric returns min/km as float", () => {
    expect(paceMinPerKmNumeric(1000 / 300)).toBeCloseTo(5, 5);
    expect(paceMinPerKmNumeric(0)).toBe(0);
  });

  it("timeAgo renders rough duration", () => {
    const now = Date.now();
    expect(timeAgo(new Date(now - 5_000).toISOString())).toMatch(/s ago/);
    expect(timeAgo(new Date(now - 5 * 60_000).toISOString())).toMatch(/m ago/);
    expect(timeAgo(null)).toBe("never");
  });
});
