/** Notify the user when a background turn finishes while the window
 * is hidden (PI-Desktop #258). Uses the Tauri notification plugin and
 * degrades to a no-op in the browser (tests, vite dev). */

let permission: "unknown" | "granted" | "denied" = "unknown";

async function ensurePermission(): Promise<boolean> {
  if (permission === "granted") return true;
  if (permission === "denied") return false;
  try {
    const { isPermissionGranted, requestPermission } =
      await import("@tauri-apps/plugin-notification");
    if (await isPermissionGranted()) {
      permission = "granted";
      return true;
    }
    permission = (await requestPermission()) ? "granted" : "denied";
    return permission === "granted";
  } catch {
    permission = "denied";
    return false;
  }
}

export type TurnNotificationOutcome = "completed" | "stopped" | "failed";

/** Fire a desktop notification; resolves false when unavailable. */
export async function notifyTurnFinished(
  sessionTitle: string,
  outcome: TurnNotificationOutcome = "completed",
): Promise<boolean> {
  if (typeof document !== "undefined" && !document.hidden) return false;
  if (!(await ensurePermission())) return false;
  try {
    const { sendNotification } =
      await import("@tauri-apps/plugin-notification");
    const detail =
      outcome === "stopped"
        ? "任务已停止"
        : outcome === "failed"
          ? "任务失败，请打开会话查看"
          : "任务已完成";
    sendNotification({
      title: "Pi Workbench",
      body: `「${sessionTitle}」的${detail}`,
    });
    return true;
  } catch {
    return false;
  }
}
