# Form registry

A form lives in one folder under this directory. Its index exports a FormDef;
registry.ts imports it and appends it to FORM_DEFS. FORM_ORDER and URL form
tokens derive from that order. Never reorder existing entries, including the
hidden, retired Hexbin entry.

## Adding a form

1. Add one folder containing index.ts, its builder(s), options.ts, and tests.
   The definition owns its label, icon, glyph, hint, availability, queries,
   spec, stats, brushability, and meaning text. Reuse shared transforms when
   their behavior is appropriate; override spec for a new rendering path.
2. Add the definition to registry.ts (import plus one registry entry).

No form-name branch belongs in the graph or the card. panel-shapes.ts and
panels/specs remain compatibility exports for callers being migrated in later
phases. Shared multi-form tests and their unchanged snapshots live in shared/.

## Options and URL compatibility

Each options.ts declares its FormOptions, field names, defaults, validator,
and URL codec entries. forms/options.ts derives FormOptionBags from the
registered definitions and composes the canonical type as:

    PanelOptions = CommonOptions & intersection(FormOptionBags[FormId])

This is the flat equivalent of common fields plus typed per-form bags. It
deliberately keeps the runtime object flat: existing patchPanel calls merge
partial options, changing form retains inactive options, and old URLs carry
those inactive values too. Normalization validates every retained form bag.

The existing graph/state.ts declaration remains structurally compatible
during phase 1. The owned normalization boundary uses the composed type.
New form controls can read their bag with optionValues(options, panel.options)
and send optionPatch(patch) through the existing command type. Adding an
optional field to the form's FormOptions automatically extends the composed
type; no shared option-type list needs editing.

URL slot numbers are independent of form registry positions. The codec
combines common fields and every form's entries, sorts by their pinned slot,
and writes the original presence masks and values. Preserve all existing
slot numbers, defaults, and scalar codecs. A future schema extension must
also consider bitmap size and version compatibility; moving ownership alone
must never change the stream. Version remains 1. url-identity.spec.ts pins
the five pre-refactor fixture strings plus positional layout, in both
directions; registry.spec.ts pins form tokens and option slot order.

## Derivation boundaries

FormDef.spec accepts either chart inputs (with optional calendar coverage) or
a panel projection input. The latter contains the existing analysis/time
projection services. Queries similarly receive the graph's query primitives.
Passing those services at call time prevents the registry from importing
graph initialization or introducing a second state pipeline. Stats delegates
the existing quantity statistics, with form-specific exclusions such as Matrix.

The compatibility exports contain no builders. Concrete marks live in form
folders; common palettes, row transforms, comparison scales, and calendar
transforms live in shared/. A shared transform may compose several existing
forms without becoming a second registration list.
