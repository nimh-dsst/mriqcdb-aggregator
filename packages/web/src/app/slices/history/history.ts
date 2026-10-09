export type UrlSyncMode = 'push' | 'replace';

/**
 * The initial write establishes the hydrated URL without creating a history
 * entry. Later writes only replace when the address bar already has the value.
 */
export function urlSyncMode(
  firstSyncAfterHydrate: boolean,
  param: string,
  current: string | null,
): UrlSyncMode {
  return firstSyncAfterHydrate || param === current ? 'replace' : 'push';
}
