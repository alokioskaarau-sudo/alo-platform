import {
  cleanupAloNowGpsLocations,
} from "./aloNowGpsRetention.service.js";

// ALO_NOW_GPS_SCHEDULER_V15
// Cleanup can continue after GPS ingestion is disabled.
// Imported by server.ts; inactive unless both flags are enabled.
// Requires cleanup flag only; GPS ingestion is independent.

export function startAloNowGpsCleanupScheduler(): () => void {
  if (
    process.env.ALO_NOW_GPS_CLEANUP_ENABLED !== "true"
  ) {
    return () => {};
  }

  let running = false;
  let closed = false;

  const timer = setInterval(() => {
    if (closed || running) return;

    if (
      process.env.ALO_NOW_GPS_CLEANUP_ENABLED !== "true"
    ) {
      return;
    }

    running = true;

    void cleanupAloNowGpsLocations()
      .catch((error: unknown) => {
        console.error("ALO NOW GPS CLEANUP ERROR", error);
      })
      .finally(() => {
        running = false;
      });
  }, 60_000);

  timer.unref?.();

  return () => {
    closed = true;
    clearInterval(timer);
  };
}
