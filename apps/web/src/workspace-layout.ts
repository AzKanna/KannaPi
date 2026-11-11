export const DEFAULT_SIDEBAR_WIDTH = 256;
export const MIN_SIDEBAR_WIDTH = 184;
export const MAX_SIDEBAR_WIDTH = 420;

export function sidebarWidthBounds(viewportWidth: number): { min: number; max: number } {
  const compact = viewportWidth <= 1_100;
  const railWidth = compact ? 56 : 64;
  const inspectorWidth = compact ? 0 : 290;
  const minimumWorkspaceWidth = compact ? 420 : 480;
  const resizeHandleWidth = 8;
  return {
    min: MIN_SIDEBAR_WIDTH,
    max: Math.max(
      MIN_SIDEBAR_WIDTH,
      Math.min(MAX_SIDEBAR_WIDTH, viewportWidth - railWidth - inspectorWidth - minimumWorkspaceWidth - resizeHandleWidth),
    ),
  };
}

export function clampSidebarWidth(value: number, viewportWidth: number): number {
  const bounds = sidebarWidthBounds(viewportWidth);
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, value)));
}
