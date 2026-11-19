/** Copy text with a small legacy fallback for older webviews. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  const previous = document.activeElement as HTMLElement | null;
  textarea.value = text;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("浏览器未允许复制，请手动选择文本");
    }
  } finally {
    textarea.remove();
    if (previous?.isConnected) previous.focus();
  }
}
