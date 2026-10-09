/**
 * Source-column name normalization, shared by the DuckDB build script and the
 * catalog so the two can never drift. See `docs/backend-graph.md`, "Serving
 * schema": the parquet dumps use dotted names verbatim, and every name is
 * normalized once at build time so no query ever quotes a dotted identifier.
 */

/**
 * Names that get a fixed translation instead of the mechanical rules, because
 * the Eve-style leading-underscore metadata columns carry no case information to
 * snake_case and `created`/`updated` read better with the `_at` suffix.
 */
const RENAMES: Readonly<Record<string, string>> = {
  _created: 'created_at',
  _updated: 'updated_at',
  _id: 'id',
};

/**
 * Source columns the DuckDB build drops rather than normalizes: the two-row
 * `Modality__altcase1` key collision, and T1w's `ImageType` exploded into five
 * sub-columns. The T2w and bold `ImageType` JSON text is kept as-is.
 */
export const DROPPED_COLUMNS: readonly string[] = [
  'bids_meta.Modality__altcase1',
  'bids_meta.ImageType.description',
  'bids_meta.ImageType.format',
  'bids_meta.ImageType.type',
  'bids_meta.ImageType.units',
  'bids_meta.ImageType.value',
];

const DROPPED = new Set(DROPPED_COLUMNS);

/** True when the build script must skip this source column entirely. */
export function isDroppedColumn(sourceName: string): boolean {
  return DROPPED.has(sourceName);
}

const BIDS_META_PREFIX = 'bids_meta.';

/**
 * CamelCase to snake_case. Splits only on case transitions, never on digit
 * boundaries, so `wm2max` and `summary_bg_p05` survive untouched while
 * `MRAcquisitionType` becomes `mr_acquisition_type`.
 */
function snakeCase(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Normalize one source column name to the identifier the DuckDB tables and the
 * catalog use.
 *
 * The rules, in order:
 * 1. a fixed rename if the name has one (`_created`, `_updated`, `_id`);
 * 2. drop a leading `bids_meta.` prefix;
 * 3. replace every remaining `.` with `_`;
 * 4. snake_case on case transitions only;
 * 5. collapse runs of `_` and trim leading and trailing ones.
 *
 * @example
 * normalizeColumnName('bids_meta.EchoTime');            // 'echo_time'
 * normalizeColumnName('provenance.settings.fd_thres');  // 'provenance_settings_fd_thres'
 * normalizeColumnName('_created');                      // 'created_at'
 */
export function normalizeColumnName(sourceName: string): string {
  const renamed = RENAMES[sourceName];
  if (renamed !== undefined) return renamed;

  const withoutPrefix = sourceName.startsWith(BIDS_META_PREFIX)
    ? sourceName.slice(BIDS_META_PREFIX.length)
    : sourceName;

  return snakeCase(withoutPrefix.replace(/\./g, '_'));
}
