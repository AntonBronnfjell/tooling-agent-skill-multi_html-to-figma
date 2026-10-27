---
name: html-to-figma
description: Migrate any HTML, CSS/SCSS, React, or Storybook web application into verified native Figma variables, COMPONENT_SET variants, and composed screens with 1:1 visual parity. Use when converting HTML/DOM views or design systems to Figma, rebuilding Storybook stories as Figma components, auditing Figma-to-DOM fidelity, or automating use_figma MCP workflows.
argument-hint: "[source-dir-or-url] [figma-file-key]"
license: MIT
metadata:
  author: anton.social
  repository: tooling-agent-skill-multi_html-to-figma
  version: 1.0.0
---

# HTML-to-Figma Migration & Verification Skill (`html-to-figma`)

## Context and Goals

**Design intent**: Convert any rendered HTML/CSS/React/Storybook application into native, editable Figma `COMPONENT_SET`s, variables, and composed screens using headless Chromium DOM geometry rather than static CSS guessing, ensuring 1:1 pixel, typographic, and token parity.

Following **Ponytail** (stdlib-first, zero external runtime dependencies, compact tuple wire format, one runnable check per non-trivial stage) and **Agentic** (explicit states, semantic tokens over raw values, testable quality gates), this skill eliminates hand-coded Figma coordinates and silent layout drift.

```
Task Progress:
- [ ] Phase 1: Bundle & Measure Live DOM in Headless Chromium (`scripts/measure-html-dom.mjs`)
- [ ] Phase 2: Compile Measured DOM to Chunked Figma Plugin Scripts (`scripts/compile-to-figma.mjs`)
- [ ] Phase 3: Push & Checkpoint via Figma MCP Bridge (`scripts/figma-mcp.mjs`)
- [ ] Phase 4: Verify Visual, Structural, and Token Parity (`scripts/verify-figma-migration.mjs`)
```

---

## Design Tokens and Foundations

1. **Resolved Computed Values Only**: Never pass raw `var(--token)` or `currentColor` into Figma node constructors. Always resolve computed RGB/RGBA and stroke/fill attributes in headless Chromium before serialization.
2. **Typography Mapping**: Map computed `fontFamily`, `fontWeight`, `fontStyle`, `fontSize`, `lineHeight`, and `letterSpacing` to preloaded Figma font styles (`Inter`, `Instrument Serif`, `JetBrains Mono`) with a `safeFont()` fallback so `use_figma` never throws on missing weights.
3. **8pt Baseline & Viewport Discipline**: Measure components at a deterministic `748px` content viewport (`780px` body with `16px` padding) with all CSS animations and transitions disabled (`animation: none !important; transition: none !important`).

---

## Component-Level Rules (Anatomy, Variants, States, Responsive Behavior)

1. **Every Story/State becomes a Native `COMPONENT` Variant**:
   - Name each state `Story=<VariantName>` inside a parent `COMPONENT_SET` named after the component (`figma.combineAsVariants(variants, page)`).
   - Required interactive states (`default`, `hover`, `focus-visible`, `active`, `disabled`, `loading`, `error`, `empty`) must be preserved as distinct variants when present in the HTML/Storybook source.
2. **DOM-to-Figma Node Anatomy**:
   - **Boxes (`kind = 0`)**: `<div|button|input|section|...>` with non-transparent background, border (`bt`, `br`, `bb`, `bl`), shadow, or `<img>`/`<hr>` become `FrameNode`s with exact 4-corner radii (`topLeftRadius`, etc.), individual stroke weights (`strokeTopWeight`, etc.), and `DROP_SHADOW` effects.
   - **Pseudo-elements & Native Inputs**: Capture `::after` indicators (radio dots, active underlines), `<input type="range">` slider thumbs, and `<input|textarea|select>` current values/placeholders.
   - **Vectors (`kind = 1`)**: Inline `<svg>` elements are cloned with computed `stroke`, `fill`, `stroke-width`, `stroke-linecap`, and `opacity` baked into attributes and instantiated via `figma.createNodeFromSvg()`.
   - **Text Runs (`kind = 2`)**: Measure text nodes via `Range.getClientRects()`. Single-line runs use `textAutoResize = "WIDTH_AND_HEIGHT"`; multi-line block wraps use `textAutoResize = "HEIGHT"` with `Math.ceil(width + 3)` to prevent premature word wrapping.
3. **Portals, Fixed Overlays, and Iframes**:
   - Monkey-patch `ReactDOM.createPortal = (children) => children` so modals, drawers, and popovers render inline inside their story container.
   - Convert `position: fixed` elements to `position: relative; width: 100%; minHeight: 440px` after mount so full-screen overlays measure within their variant frame.
   - Recursively traverse same-origin `<iframe>` documents (`el.contentDocument.body`) for email and embedded preview components.

---

## Step-by-Step Workflow

### Phase 1: Measure HTML / Storybook DOM (`scripts/measure-html-dom.mjs`)

Execute `scripts/measure-html-dom.mjs` to render the target HTML file, URL, or Storybook static build in headless Chromium and output `/tmp/measured-stories.json`:

```bash
# Measure an HTML file containing [data-component] and [data-story] elements:
node scripts/measure-html-dom.mjs --html path/to/index.html --out /tmp/measured-stories.json

# Measure a Storybook static build by range (1-based):
node scripts/measure-html-dom.mjs --storybook ./storybook-static --range 1 30 --out /tmp/measured-stories.json

# Run built-in self-test:
node scripts/measure-html-dom.mjs --self-test
```

### Phase 2: Compile to Chunked Figma Plugin Scripts (`scripts/compile-to-figma.mjs`)

Compile the measured JSON into compact, deduplicated Figma Plugin scripts (`<46 KB` per part, well below `use_figma`'s `50,000`-character limit):

```bash
node scripts/compile-to-figma.mjs /tmp/measured-stories.json ./build-batch.js 230 --page "52:2"
```

When a component set has many tall variants, `compile-to-figma.mjs` automatically emits `.part2.js`, `.part3.js`, etc. using `isAppend = true` so subsequent parts append variants directly into the existing `COMPONENT_SET`.

### Phase 3: Push & Checkpoint via Figma MCP (`scripts/figma-mcp.mjs`)

Execute the compiled script (and any `.partN.js` continuation files) against the target Figma file:

```bash
node scripts/figma-mcp.mjs use <FIGMA_FILE_KEY> ./build-batch.js "Rebuild validated components"
```

### Phase 4: Verify Migration (`scripts/verify-figma-migration.mjs`)

Always run deterministic verification immediately after compiling and after pushing:

```bash
node scripts/verify-figma-migration.mjs \
  --measured /tmp/measured-stories.json \
  --scripts ./build-batch.js
```

Only mark a component batch complete when `verify-figma-migration.mjs` exits `0` with `STATUS: PASS`.

---

## Accessibility Requirements & Testable Acceptance Criteria

- **Screen-Reader Hidden Nodes**: Elements with `width <= 1.5 && height <= 1.5` and `overflow: hidden` or `clip !== "auto"` (`.sr-only` / `VisuallyHidden`) must be excluded from visual box emission unless explicitly showcasing accessibility helpers.
- **Touch & Hit Targets**: Interactive controls (`button`, `input`, `[role="button"]`) preserve their exact measured hit box (`>= 32px–44px`).
- **Contrast & Semantic Colors**: Text and border colors preserve exact computed RGB values from the active theme (`data-theme="paper"` or `data-theme="night"`).

---

## Content and Tone Standards

- **Variant Naming**: Preserve human-readable Storybook story names (`Story=Default`, `Story=With Error`, `Story=Mobile`).
- **Section Captions**: Every `COMPONENT_SET` on the validation canvas is preceded by a `40px` heading (`compName`) and a `14px` provenance caption:
  `Validated against <Category/Component> — <N> canonical Storybook variants (<list>) measured in headless Chromium at 748px viewport.`

---

## Anti-Patterns and Prohibited Implementations

- **Do NOT** hand-estimate text width (`text.length * 7`) or box heights in Figma scripts; **always** use `getBoundingClientRect()` and `Range.getClientRects()` from headless Chromium.
- **Do NOT** emit `use_figma` payloads larger than `46,000` characters; split into `.partN.js` continuation scripts.
- **Do NOT** leave `position: fixed` backdrops unpatched—they will collapse to `0px` height or cover the entire viewport outside the story container.
- **Do NOT** use Vite's default Sass preprocessor when `sass-embedded` is unavailable; use the `enforce: 'pre'` CSS-Modules transformer in [references/architecture-and-tokens.md](references/architecture-and-tokens.md).

---

## Hooks & Evals

- **Cursor Project Hook (`.cursor/hooks.json`)**: Runs `.cursor/hooks/verify-figma-payload.sh` on `afterFileEdit` and `beforeShellExecution` to block oversized (`>50,000` chars) or unvalidated Figma scripts (`exit 2`).
- **Evaluation Suite (`evals/evals.json` & `evals/grade-evals.mjs`)**: Run `node evals/grade-evals.mjs` to execute deterministic end-to-end assertions across DOM measurement, tuple compilation, hook gating, and parity verification.

## QA Checklist

- [ ] `measure-html-dom.mjs` reports `0` window errors and `0` unhandled rejections across all stories
- [ ] Every story has `rootRect[0] >= 16` and `rootRect[1] >= 16` and non-empty `items`
- [ ] Every generated `.js` / `.partN.js` file is `< 46,000` characters
- [ ] `verify-figma-migration.mjs` passes with `0` missing variants and `0` unresolved tokens
- [ ] `node evals/grade-evals.mjs` passes `100%` of assertions

## Additional Resources

- For tuple wire format, font codes, and CSS-Module bundling internals, see [references/architecture-and-tokens.md](references/architecture-and-tokens.md).
