export interface RuntimeCpuUsageProcess {
  cpuUsage?: (previous?: { user: number; system: number }) => {
    user: number;
    system: number;
  };
}

/** Optional runtime telemetry must never become an ingestion capability gate.
 * Some edge runtimes expose Node-compatible process methods as throwing stubs. */
export function runtimeCpuUsage(
  runtimeProcess: RuntimeCpuUsageProcess | undefined,
): (() => number | null) | null {
  if (!runtimeProcess?.cpuUsage) return null;
  try {
    const start = runtimeProcess.cpuUsage();
    return () => {
      try {
        const elapsed = runtimeProcess.cpuUsage!(start);
        return Math.round((elapsed.user + elapsed.system) / 100) / 10;
      } catch {
        return null;
      }
    };
  } catch {
    return null;
  }
}
