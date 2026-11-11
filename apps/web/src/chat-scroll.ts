type ScrollMetrics = Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">;

export function isNearChatBottom({ scrollTop, scrollHeight, clientHeight }: ScrollMetrics): boolean {
  return scrollHeight - clientHeight - scrollTop <= 24;
}
