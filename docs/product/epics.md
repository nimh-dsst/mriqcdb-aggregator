# MRIQC population dashboard — epics

## Personas

### PI deciding whether data is usable
Goal: decide whether a site's, study's, or scanner's data is good enough to use or publish as-is. Knows: the science question, not DuckDB or MRIQC internals. Frequency: per study. Decides: accept, flag, or exclude a batch.

### QC analyst triaging a new batch
Goal: find which scans in a freshly ingested or uploaded batch need a second look. Knows: the IQMs; not necessarily canonicalization rules. Frequency: every ingest/upload. Decides: which scan IDs go to manual review.

### Methods researcher studying IQM behaviour
Goal: characterize how an IQM varies with acquisition parameters across the population, for a methods paper. Knows: the metrics deeply, not the dashboard internals. Frequency: sustained bursts. Decides: which claims about metric behaviour are defensible.

### Site/scanner operator watching one scanner
Goal: catch drift, dumps, or outages at their own site before they corrupt studies. Knows: their scanner, not the wider population. Frequency: recurring, lightweight. Decides: when to flag the scanner for physics QA.

### Data manager running ingests and sharing links
Goal: keep the data current, correct, and explainable. Knows: the ingest pipeline, not the statistics. Frequency: every ingest cycle. Decides: when to ingest, what view a shared link points to.

### Newcomer deciding whether to adopt MRIQC-based QC
Goal: in minutes, judge whether this kind of population-referenced QC is worth adopting. Knows: little about MRIQC. Frequency: once, maybe a few returns. Decides: whether to invest further.

### Meta-paper researcher (pooling/contrasting studies)
Goal: pool or contrast many studies, sites, or scanners using the IQMs as the paper's data. Knows: statistics and study design, not this codebase. Frequency: sustained, over a manuscript's life. Decides: which pooled/contrasted numbers are citable, with what provenance.

### MRIQC-itself researcher (the tool as the object of study)
Goal: characterize MRIQC as an instrument — how IQMs shift across MRIQC versions, which are stable or redundant, how dedup policy changes counts, version×vendor interactions, run-to-run stability of repeat uploads. Knows: MRIQC's internals deeply. Frequency: sustained, methods-paper pace. Decides: which version/metric behaviours are worth warning the field about.

### Methods person validating a new QC cutoff
Goal: test a proposed metric or threshold against the real population before recommending it. Knows: the proposed cutoff's rationale, not this population's shape. Frequency: a short, focused burst per proposal. Decides: whether the cutoff is reasonable and how much data it would remove, and where.

### Reviewer/editor checking a paper's QC claims
Goal: sanity-check a submitted paper's QC statement ("FD < 0.3 mm") against the real population in minutes. Knows: the paper's claim, nothing about this dashboard beforehand. Frequency: once per review, under time pressure. Decides: whether to challenge the claim in review.

### Scanner/physics person diagnosing drift
Goal: build a technical, metric-grounded case that one scanner has drifted, for a service request. Knows: the physics and the metrics; wants precision, not a glance. Frequency: triggered by a complaint or a periodic check. Decides: whether to request physics QA, and what evidence to attach.

## Epics

### E1 Judge one site, study, or subset against the field
Who: PI, researcher, reviewer/editor, cutoff-validator · Why it matters: "is my subset normal?" gates publication or re-QC. Done when: any filter combination becomes a named cohort, overlaid against the population or another cohort, with n and a readable difference. In scope: cohort creation from filters, comparison panel (density/step/ECDF/box), saved cohorts, group-derived cohorts. Out of scope: automated significance testing. Depends on: E3, E7. Open: what counts as "different enough" to flag.

Specific tasks:
- "Is this site's FD mean typical, or an outlier, against the whole population?" (PI, reviewer) `[can]`
- "If I cut at FD mean 0.2 mm, what fraction of each site/vendor would that exclude?" (cutoff-validator) `[partly]` — per-group quantile/ECDF reads exist; no built-in "% excluded by my cutoff" table across many groups at once.
- "Check whether 'FD < 0.3 mm is typical' is actually true for this modality." (reviewer) `[can]`
- "Keep this site's cohort comparison running as new data lands." (PI) `[can]`
- "Compare two vendors against each other, not against the whole population." (researcher) `[can]`
- "Get a citable effect size (not just a picture) between my cohort and the population." (meta-paper researcher) `[cannot]` — no formal effect-size statistic between cohorts is described.

### E2 Compare your own uploaded study against the population
Who: PI, researcher · Why it matters: a PI's own scans vs. ~778k population scans, on identical statistics. Done when: an uploaded study behaves as a cohort in every panel type, computed client-side, rows never leaving the browser. In scope: upload/parse, in-browser SQL identical to the server's, join into comparisons and correlation. Out of scope: storing or re-sharing uploaded data. Depends on: E1.

Specific tasks:
- "Upload my study and see it plotted against the population." (PI) `[can]`
- "Use the exact same quantile/histogram definitions on my study as on the population." (PI) `[can]` — explicit design goal.
- "Correlate two IQMs in my study next to the population's correlation matrix." (researcher) `[can]`
- "Send a colleague a link to this comparison." (PI) `[partly]` — study rows never enter the URL; the colleague must re-upload the same file.
- "Export my study merged with population summary stats for offline analysis." (researcher) `[cannot]` — no merged study+population export is described.
- "See which of my scans would pass K4+/K3++ admission." (PI) `[cannot]` — canonicalization is a server-side policy over ingested raw data, not an uploaded-study operation.

### E3 Understand the population: what is normal
Who: all, especially meta-paper researcher · Why it matters: every comparison needs a reference distribution. Done when: any metric/modality/view query returns n, quantiles, and a meaning line without outside documentation. In scope: per-metric/modality distributions, grouped views, default metric sets, the rows×quantity×series×form model. Out of scope: prescriptive "good/bad" thresholds. Depends on: none.

Specific tasks:
- "Get median and IQR of tSNR per vendor, 3T only, as a table I can cite." (meta-paper researcher) `[can]`
- "See how an IQM's distribution differs for 1.5T vs 3T." (researcher) `[can]`
- "See the n behind every number, always." (all) `[can]`
- "Pool sites with fewer than 50 scans into Other and compare the rest." (meta-paper researcher) `[partly]` — categorical grouping caps at 50 distinct values with automatic Other pooling, not a user-set minimum-n-per-group fold.
- "Look at T1w and T2w metrics, not just BOLD." (researcher) `[can]`
- "Get a per-site summary table for every site in one pass, not one cohort at a time." (meta-paper researcher) `[partly]` — one grouped table per query; no bundled multi-site export is described.

### E4 Watch change over time: drift, dumps, outages
Who: scanner operator, physics person, MRIQC-version researcher · Why it matters: a scanner or pipeline problem is a time-shaped signal a snapshot hides. Done when: any metric or count can be plotted over time, scoped to one scanner, with thin/missing periods called out. In scope: time as a first-class axis, coverage, median-band-over-time, thin-bucket flagging. Out of scope: automated alerts. Depends on: E3.

Specific tasks:
- "Show FD mean for my scanner, month by month, for the last year." (operator) `[can]`
- "Flag months where my scanner has too few scans to trust the number." (operator) `[can]` — thin-bucket flag at n<20.
- "Alert me automatically when my scanner drifts." (operator) `[cannot]` — no notification/alerting is described.
- "See if an IQM's level shifted at a known MRIQC version upgrade date." (MRIQC-version researcher) `[partly]` — time axis works; aligning a shift to a version label isn't built in.
- "Compare my scanner's trend against the population's trend, same window." (physics person) `[can]`
- "See a gap where my scanner uploaded nothing for weeks." (operator) `[can]`

### E5 Explore relationships between metrics
Who: researcher, MRIQC-version researcher · Why it matters: IQMs aren't independent; redundancy and acquisition-driven correlation change what's worth reporting. Done when: a user sees pairwise correlation across a metric family and drills from any cell into its 2D distribution. In scope: correlation matrix, 2D density/scatter/hexbin, exploratory clustering. Out of scope: causal inference. Depends on: E3.

Specific tasks:
- "See which IQMs move together across the whole BOLD population." (researcher) `[can]`
- "Drill from a correlated pair into their actual scatter." (researcher) `[can]`
- "Check whether two metrics are redundant enough to report just one." (MRIQC-version researcher) `[can]` — r is given; the judgment is the researcher's.
- "Cluster scans by two metrics to see if there are distinct regimes." (researcher) `[can]`
- "See whether the correlation structure itself differs between two MRIQC versions." (MRIQC-version researcher) `[partly]` — the matrix shows one cohort at a time; no side-by-side version-delta view.
- "Get the correlation matrix's numbers as a citable table, not just a picture." (meta-paper researcher) `[partly]` — numbers are on-screen; row export is raw rows, not the derived matrix.

### E6 Triage a new batch for likely outliers
Who: QC analyst · Why it matters: someone must turn "this batch landed" into a short list of scans worth a human look. Done when: an analyst narrows to likely-outlier scans by range or cohort and reaches the raw records behind them. In scope: outlier-cohort queries, raw drill-down with column allowlist, caps/cursoring. Out of scope: a review-queue workflow. Depends on: E3, E8.

Specific tasks:
- "Pull the scans in this batch with FD mean above the population's p99." (QC analyst) `[can]`
- "Get the raw rows behind an outlier range, with id, to trace back to the source study." (QC analyst) `[can]`
- "See only this batch's upload window, not the whole history." (QC analyst) `[can]` — created_at filter.
- "Get an automatic list of likely-bad scans, without me picking a range." (QC analyst) `[cannot]` — purely user-driven selection, no automatic flagging.
- "Check whether an apparent outlier is actually a canonicalization-quarantined duplicate." (QC analyst) `[can]` — the `_all` (quarantined) view plus `canonical_diameter`/`canonical_group_rows` are filterable fields on canonical views.
- "Export the flagged scans with the dedup policy explicitly noted on each row." (QC analyst) `[partly]` — the policy columns export; an explicit "policy used" label per export isn't described.

### E7 Trust and interpret what's shown
Who: all, especially newcomer and PI · Why it matters: every other epic's output is only as good as the viewer's ability to read it correctly. Done when: every panel states its meaning, n, and view in place. In scope: meaning lines, visible n/view selector, exploratory/approximate labeling. Out of scope: a full statistics tutorial. Depends on: none.

Specific tasks:
- "Know what 'deduplicated' means before I trust this number." (newcomer) `[partly]` — meaning lines exist; full rationale may live in docs, not in-product.
- "See the n behind every chart, always." (all) `[can]`
- "Tell raw counts from canonical (deduplicated) counts for the same filter." (PI) `[can]` — view selector.
- "Cite the exact dedup policy version a number used." (meta-paper researcher) `[partly]` — `provenance_version`/`canonical_policy` columns exist; an explicit on-panel policy-version label isn't confirmed.
- "Understand what an unfamiliar IQM (e.g. EFC) actually measures." (newcomer) `[partly]` — meaning lines give some interpretation; full per-metric glossary coverage is open.
- "Know that a clustering or 'Other' quantile is approximate, not exact." (researcher) `[can]` — explicitly labeled by design.

### E8 Keep the population current, with provenance visible
Who: data manager, meta-paper researcher · Why it matters: a dashboard that goes silently stale loses the trust everything else depends on. Done when: any visitor sees data currency without asking the data manager, and ingest never yields an inconsistent read. In scope: visible data version, consistent-snapshot reads, snapshot retention. Out of scope: real-time push notification. Depends on: none.

Specific tasks:
- "See what the last ingest added, replaced, or skipped." (data manager) `[partly]` — the CLI prints this; UI exposure beyond the currency date is unclear.
- "Know exactly which data snapshot/version a number in my paper came from." (meta-paper researcher) `[can]` — `data_version`/`catalogVersion` visible.
- "Roll back to yesterday's data after a bad ingest." (data manager) `[partly]` — snapshot files exist; rollback is a manual file swap, not a UI action.
- "Confirm I never see a half-written ingest." (all) `[can]` — consistent snapshot reads.
- "Run ingest without taking the dashboard down." (data manager) `[can]` — nightly in-process ingest, readers unblocked.
- "See whether today's data includes the newest export yet." (data manager) `[can]` — "Uploads through <date>".

### E9 Share and reproduce an exact view
Who: all · Why it matters: a finding that can't be handed to a colleague or cited reproducibly isn't finished. Done when: any state round-trips through a URL that reopens identically, and data exports for offline use. In scope: full state-in-URL, link copy, raw-row export (Arrow/CSV). Out of scope: accounts, saved-dashboard galleries, access control. Depends on: E1, E3.

Specific tasks:
- "Send a colleague a link that reopens this exact chart." (all) `[can]`
- "Export the rows behind this chart, with the dedup policy noted, for my own stats software." (meta-paper researcher) `[partly]` — export carries the policy columns; an explicit label isn't confirmed.
- "Export a grouped summary table, not raw rows, for citation." (meta-paper researcher) `[partly]` — the table renders on-screen; the export route is row-level, not an aggregate-table endpoint.
- "Reopen a six-month-old link and get the same numbers." (reviewer) `[partly]` — the view/filters reproduce exactly; the underlying population can have grown since, so numbers can drift.
- "Share a comparison that includes my uploaded study." (PI) `[cannot]` — study rows never leave the browser, by design.
- "Pick a custom bin count or range and have that exact choice travel in the link." (researcher) `[can]`

### E10 Onboard a newcomer in five minutes
Who: newcomer · Why it matters: adoption depends on a first visit answering "is this worth my time." Done when: a visitor with zero context reaches a readable comparison unaided, even on mock data. In scope: no-setup mock mode, guided panel creation from a plain-language question, a short explanation. Out of scope: a full tour system. Depends on: E3, E7.

Specific tasks:
- "Try it with no data of my own and no server to run." (newcomer) `[can]` — built-in mock mode.
- "Ask a plain question and get a chart, without knowing column names." (newcomer) `[can]` — guided mode.
- "Understand what MRIQC and 'deduplicated' mean without leaving the page." (newcomer) `[partly]` — depth of in-product explanation is open.
- "See a worked comparison example before uploading my own study." (newcomer) `[partly]` — mock data exists; a guided worked comparison beyond single-question guidance is unclear.
- "Decide in under five minutes, without installing anything." (newcomer) `[can]` — hosted, no login, mock mode immediate.

### E11 Operate and deploy the dashboard
Who: data manager · Why it matters: this is team infrastructure a non-developer must be able to run. Done when: an operator installs, builds, runs, ingests, and rolls back using only the operator guide. In scope: install/build/run docs, sizing guidance, nightly ingest, snapshot rollback. Out of scope: multi-tenant hosting, auth, horizontal scaling (none planned by design). Depends on: E8.

Specific tasks:
- "Install and run it on a machine with no prior exposure to the codebase." (data manager) `[can]`
- "Add new data every night without a daily terminal session." (data manager) `[can]` — automatic nightly ingest.
- "Roll back a bad ingest." (data manager) `[can]` — snapshot file swap.
- "Know how much memory/disk I need before I start." (data manager) `[can]` — documented sizing.
- "Run it publicly with no login, within the controls it has." (data manager) `[can]` — explicit no-auth design; caps/rate limits are the control.
- "Scale it to many simultaneous visitors." (data manager) `[cannot]` — single Node process, one DuckDB writer; no horizontal scaling is designed.

## Not epics (deliberately)

Dark mode, undo/redo, keyboard shortcuts, drag-to-reorder panel layout, per-user accounts or saved dashboards, real-time collaboration cursors, notification/alerting on data changes, and localization — each is a feature that could sit inside an epic above (most often E9 or E11) but names a UI mechanism or convenience, not an outcome or decision the dashboard exists to support.
