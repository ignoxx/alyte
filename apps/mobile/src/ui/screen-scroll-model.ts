/**
 * Resolve the bottom inset needed by a screen scroll surface.
 *
 * Native tabs may not provide a React Navigation height context when a screen is nested below a
 * native stack. In that case, retain the device safe area and add the caller's shared clearance.
 * A measured tab bar remains authoritative when it is available, while a short or stale value
 * cannot reduce the device-safe fallback.
 */
export function getScreenScrollBottomInset(
  tabBarHeight: number | undefined,
  safeAreaBottom: number,
  minimumNativeTabBarClearance = 0,
): number {
  const safeBottom = Number.isFinite(safeAreaBottom) ? Math.max(0, safeAreaBottom) : 0;
  const minimumClearance = Number.isFinite(minimumNativeTabBarClearance)
    ? Math.max(0, minimumNativeTabBarClearance)
    : 0;
  const measuredTabBarHeight =
    tabBarHeight !== undefined && Number.isFinite(tabBarHeight) ? Math.max(0, tabBarHeight) : 0;

  return Math.max(measuredTabBarHeight, safeBottom + minimumClearance);
}
