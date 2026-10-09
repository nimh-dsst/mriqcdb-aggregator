# August dump fixture

The first 300 records of each August 2026 full dump (`T1w`, `T2w`, `bold`,
`rating`), retaining the original mongoexport extended-JSON objects. The dated
filenames exercise the dump tool's adoption convention. Tests copy these files
to an OS temporary directory before creating a manifest.

The independently built 300-row Parquet sample admits 267 BOLD, 276 T1w and
264 T2w canonical groups. T1w also has 12 quarantined rows across five groups.
