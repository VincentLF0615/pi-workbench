/** Only web links may leave the application through the system opener. */
export function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** Open a validated web link with Pi Workbench's existing opener plugin. */
export async function openExternal(value: string): Promise<void> {
  const safe = safeExternalUrl(value);
  if (!safe) throw new Error("只允许打开 http/https 链接");
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(safe);
}
