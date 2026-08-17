export const DIALOG_FOCUSABLE_SELECTOR = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function isRowActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ';
}

/**
 * Return the focus target needed to keep Tab inside a dialog.
 * null means the dialog itself should receive focus; undefined means the
 * browser can continue with its normal in-dialog Tab movement.
 */
export function trappedFocusTarget<T>(
  items: readonly T[],
  active: T | null,
  shiftKey: boolean,
): T | null | undefined {
  if (!items.length) return null;
  if (shiftKey && active === items[0]) return items[items.length - 1];
  if (!shiftKey && active === items[items.length - 1]) return items[0];
  return undefined;
}
