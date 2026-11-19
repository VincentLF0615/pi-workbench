import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type RefObject,
} from "react";

const focusableSelector = [
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(focusableSelector),
  ).filter((element) => element.tabIndex >= 0);
}

/** Shared modal focus, keyboard and guarded-close behavior. */
export function useDialogFocus<T extends HTMLElement>({
  open,
  onClose,
  dialogRef,
  initialFocusRef,
  pending = false,
}: {
  open: boolean;
  onClose: () => void;
  dialogRef: RefObject<T | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  pending?: boolean;
}) {
  const closeRef = useRef(onClose);
  const pendingRef = useRef(pending);
  const previousFocus = useRef<HTMLElement | null>(null);
  closeRef.current = onClose;
  pendingRef.current = pending;

  const requestClose = useCallback(() => {
    if (!pendingRef.current) closeRef.current();
  }, []);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => {
      const dialog = dialogRef.current;
      const target =
        initialFocusRef?.current ??
        (dialog ? focusableElements(dialog)[0] : null) ??
        dialog;
      target?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      const previous = previousFocus.current;
      previousFocus.current = null;
      if (previous?.isConnected) previous.focus();
    };
  }, [open, dialogRef, initialFocusRef]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<T>) => {
      if (event.key === "Escape") {
        // A modal Escape must never fall through to App's abort shortcut.
        event.preventDefault();
        event.stopPropagation();
        requestClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = focusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (active === last || !dialog.contains(active))
      ) {
        event.preventDefault();
        first.focus();
      }
    },
    [dialogRef, requestClose],
  );

  return { requestClose, onKeyDown };
}
