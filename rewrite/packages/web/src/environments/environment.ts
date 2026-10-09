/**
 * Build-time switches. One flag for now: which `Api` the graph gets.
 *
 * The dashboard talks to the real tRPC router. `MockApi` stays reachable so a
 * screenshot, a demo or a browser test can run without a server behind it --
 * see `useMockApi`.
 */
export const environment = {
  /** Serve every panel from `MockApi` instead of the tRPC router. */
  useMock: false,

  /**
   * User-facing features that can be disabled independently at build time.
   *
   * `studyUpload`: an uploaded study is one more **cohort**
   * (`docs/comparison-design.md`, "Study upload") -- `source: 'study'`, answered
   * by a DuckDB-WASM runner against the shared SQL templates. The file picker,
   * runner and study-cohort controls are enabled together by this flag.
   *
   * It no longer gates the comparison panel. A comparison is between cohorts,
   * and "This dashboard" and "Whole population" always exist, so the panel kind
   * is always offered and always draws something.
   */
  features: {
    studyUpload: true,
  },
} as const;

function readFlag(value: string | null): boolean | null {
  if (value === null) return null;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return null;
}

/**
 * Which `Api` to provide: `?mock=1` (or `?mock=0`) wins, otherwise the
 * build-time default.
 *
 * The choice is deliberately not remembered anywhere. It used to be written to
 * `localStorage`, which made one shared link switch its recipient to fabricated
 * data for every later visit, with nothing on screen saying so. It does not need
 * to be: the parameter survives a reload in the address bar, and `syncUrl`
 * merges it into every in-app navigation, so it lasts exactly as long as the URL
 * that asked for it. The top bar shows a badge while it is on.
 *
 * The read is guarded: a browser that throws on `location` must not take the
 * application down.
 */
export function useMockApi(): boolean {
  if (typeof window === 'undefined') return environment.useMock;
  try {
    return readFlag(new URLSearchParams(window.location.search).get('mock')) ?? environment.useMock;
  } catch {
    return environment.useMock;
  }
}
