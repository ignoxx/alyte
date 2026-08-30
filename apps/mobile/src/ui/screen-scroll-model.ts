/**
 * Resolve the bottom inset needed by a screen scroll surface.
 *
 * UIKit's automatic policy returns only the additional translucent-tab clearance, preventing a
 * second safe-area inset from creating artificial empty scroll range. The legacy policy preserves
 * the pre-native-tab Android/web fallback, including its complete bottom safe-area allowance.
 *
 * Native tabs may not provide a React Navigation height context when a screen is nested below a
 * native stack. A measured tab bar is reduced by the safe area it already contains; when no
 * measurement exists, the caller's minimum extra clearance remains the safe fallback.
 */
export function getScreenScrollBottomInset(
  tabBarHeight: number | undefined,
  safeAreaBottom: number,
  minimumNativeTabBarClearance = 0,
  adjustment: 'automatic' | 'legacy' = 'legacy',
): number {
  const safeBottom = Number.isFinite(safeAreaBottom) ? Math.max(0, safeAreaBottom) : 0;
  const minimumClearance = Number.isFinite(minimumNativeTabBarClearance)
    ? Math.max(0, minimumNativeTabBarClearance)
    : 0;
  const measuredTabBarHeight =
    tabBarHeight !== undefined && Number.isFinite(tabBarHeight) ? Math.max(0, tabBarHeight) : 0;

  if (adjustment === 'legacy') {
    return Math.max(measuredTabBarHeight, safeBottom + minimumClearance);
  }

  const measuredExtra = Math.max(0, measuredTabBarHeight - safeBottom);
  return Math.max(measuredExtra, minimumClearance);
}

export type ScreenPlatformPolicy = 'ios-native-tabs' | 'legacy';
export type ScreenSafeAreaEdge = 'left' | 'right' | 'bottom';

/** Keep the platform branch pure so iOS's native-tab exception cannot leak into Android or web. */
export function getScreenPlatformPolicy(platform: string | undefined): ScreenPlatformPolicy {
  return platform === 'ios' ? 'ios-native-tabs' : 'legacy';
}

export function getScreenSafeAreaEdges(policy: ScreenPlatformPolicy): ScreenSafeAreaEdge[] {
  return policy === 'ios-native-tabs' ? ['left', 'right'] : ['left', 'right', 'bottom'];
}

/** A status shell lays out against the complete tab-safe bottom region before it can scroll. */
export function getScreenStatusBottomInset(
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

export function getScreenStatusAvailableHeight(
  viewportHeight: number,
  topClearance: number,
  bottomClearance: number,
): number {
  const viewport = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  const top = Number.isFinite(topClearance) ? Math.max(0, topClearance) : 0;
  const bottom = Number.isFinite(bottomClearance) ? Math.max(0, bottomClearance) : 0;
  return Math.max(0, viewport - top - bottom);
}

export function getScreenStatusScrollEnabled(
  contentHeight: number,
  availableHeight: number,
): boolean {
  if (!Number.isFinite(contentHeight) || !Number.isFinite(availableHeight)) return false;
  return Math.max(0, contentHeight) > Math.max(0, availableHeight);
}

/** Accessibility text sizes use a top-anchored overflow layout so actions cannot be clipped. */
export function getScreenStatusUsesOverflowLayout(fontScale: number): boolean {
  return Number.isFinite(fontScale) && fontScale >= 1.3;
}

export type ScreenSurfaceState = 'loading' | 'error' | 'empty' | 'populated';

export function getScreenSurfaceMode(state: ScreenSurfaceState): 'status' | 'scroll' {
  return state === 'populated' ? 'scroll' : 'status';
}
