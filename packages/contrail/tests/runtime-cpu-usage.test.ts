import { describe, expect, it } from "vitest";
import { runtimeCpuUsage } from "../src/core/runtime-telemetry";

describe("optional runtime CPU telemetry", () => {
  it("returns null when process or process.cpuUsage is absent", () => {
    expect(runtimeCpuUsage(undefined)).toBeNull();
    expect(runtimeCpuUsage({})).toBeNull();
  });

  it("returns null when the initial cpuUsage call throws", () => {
    const finish = runtimeCpuUsage({
      cpuUsage() {
        throw new Error("not implemented");
      },
    });

    expect(finish).toBeNull();
  });

  it("returns null for the metric when the elapsed cpuUsage call throws", () => {
    const finish = runtimeCpuUsage({
      cpuUsage(previous) {
        if (previous) throw new Error("elapsed measurement failed");
        return { user: 100, system: 50 };
      },
    });

    expect(finish).not.toBeNull();
    expect(finish?.()).toBeNull();
  });

  it("reports numeric milliseconds when cpuUsage is supported", () => {
    const start = { user: 100, system: 50 };
    const finish = runtimeCpuUsage({
      cpuUsage(previous) {
        if (!previous) return start;
        expect(previous).toBe(start);
        return { user: 1_200, system: 300 };
      },
    });

    expect(finish?.()).toBe(1.5);
  });

  it("continues to measure CPU time with Node's implementation", () => {
    const finish = runtimeCpuUsage(process);

    expect(finish).not.toBeNull();
    expect(finish?.()).toEqual(expect.any(Number));
  });
});
