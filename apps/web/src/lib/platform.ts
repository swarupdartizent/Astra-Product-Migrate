/** True on Apple platforms, where the primary shortcut modifier is ⌘ rather than Ctrl. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? navigator.platform;
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** Label for the primary shortcut modifier on this platform. */
export function modKeyLabel(): string {
  return isApplePlatform() ? '⌘' : 'Ctrl';
}
