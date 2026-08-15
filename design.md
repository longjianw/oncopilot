# Design — OncoPilot

A locked, clinical-workbench design system for OncoPilot. Every page redesign
reads this file before emitting code. Extend this system when needed; do not
invent a competing per-page theme.

## Genre

Modern-minimal, adapted for a Chinese clinical workbench: precise, quiet and
operational rather than a marketing landing page.

## Macrostructure family

- Marketing pages: not currently shipped.
- App pages: Workbench. Functional context sits beside the active work area;
  dense evidence is separated by rules, tables and restrained surfaces rather
  than promotional cards.
- Content pages: Long Document if later needed.

## Theme

The `tokens.css` file is authoritative. It uses a cool blue-grey paper, ink
with a blue undertone, and one cobalt signal accent. Green, amber and red are
reserved for status; they are not decorative accents.

## Typography

- Display: `var(--font-display)`, weight 700, roman.
- Body: `var(--font-body)`, weight 400.
- Mono: `var(--font-mono)`, weight 600 for version, source IDs and numbers.
- Chinese text prioritizes the operating system's high-quality CJK UI face;
  the wordmark and operational labels provide the contrasting mono register.
- No italic headings, gradient text or all-caps body copy.

## Spacing

Use the named 4-point spacing tokens. App pages use deliberate open gaps
between workflow stages and compact spacing inside controls.

## Motion

- Easing: `var(--ease-out)`.
- No entrance choreography. State transitions only.
- Reduced motion removes animation and preserves immediate feedback.

## Microinteractions stance

- Silent success; no celebration or bouncing.
- Focus is visible immediately.
- Buttons move only through colour, rule and a 1px active press.

## CTA voice

- Primary: compact cobalt fill, rectangular-soft corners, one direct verb.
- Secondary: quiet outlined chip or underlined text action.

## Per-page allowances

- App pages must not use hero art, fake browser chrome, gradient surfaces or
  decorative ambient blobs.
- The actual document, event ledger, blind A/B evidence and meeting output are
  the visual focus.

## What pages must share

- Wordmark treatment, colour tokens, typography, focus ring and control shape.
- Narrow operational header and single-line footnote footer.
- `Workbench` information rhythm: context first, work surface second, evidence
  visible without promotional framing.

## What pages may differ on

- The active work surface: document drafting on `/`, experimental evidence on
  `/evaluation-lab`.
- The amount of data-table density needed by the page.
