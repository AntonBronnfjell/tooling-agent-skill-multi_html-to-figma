# Architecture, Compact Tuple Wire Format & Token Mapping

## 1. Compact Tuple Wire Format (`DATA`)

To keep `use_figma` scripts well under the `50,000`-character MCP limit while building dozens of multi-variant components per round-trip, `scripts/compile-to-figma.mjs` deduplicates all color/shadow strings into `STRS[]` and all serialized `<svg>` markup into `SVGS[]`, encoding each DOM item as a compact array tuple:

| Kind | Tuple Signature | Description |
|------|----------------|-------------|
| `0` (Box) | `[0, x, y, w, h, bgIdx, bt, br, bb, bl, radius, shadowIdx, opacity]` | `FrameNode` with optional fill (`STRS[bgIdx]`), 4-side borders (`[weight, styleCode, colorIdx]`), uniform or 4-corner radius, `DROP_SHADOW` (`STRS[shadowIdx]`), and opacity. |
| `1` (SVG) | `[1, x, y, w, h, svgIdx, opacity]` | `figma.createNodeFromSvg(SVGS[svgIdx])` positioned at `(x, y)` and resized to `(w, h)`. |
| `2` (Text) | `[2, x, y, w, h, text, fontCode, fontSize, lineHeight, letterSpacing, colorIdx, flags, opacity, lineCount]` | `TextNode` with preloaded font (`FONT_MAP[fontCode]`), `flags` bitmask (`1 = UPPERCASE`, `2 = UNDERLINE`), and auto-resize (`WIDTH_AND_HEIGHT` when `lineCount === 1`, `HEIGHT` when `lineCount > 1`). |

## 2. Font Code Table (`FONT_MAP`)

| Code | Figma Font Family | Style | Tight Tracking Compensation |
|------|-------------------|-------|-----------------------------|
| `Ir` / `Tr` | `Inter` | `Regular` | `Tr` applies `-0.25px` when `letterSpacing == 0` |
| `Im` / `Tm` | `Inter` | `Medium` | `Tm` applies `-0.25px` when `letterSpacing == 0` |
| `Is` / `Ts` | `Inter` | `Semi Bold` | `Ts` applies `-0.25px` when `letterSpacing == 0` |
| `Ib` / `Tb` | `Inter` | `Bold` | `Tb` applies `-0.25px` when `letterSpacing == 0` |
| `Ii` / `Ti` | `Inter` | `Italic` | `Ti` applies `-0.25px` when `letterSpacing == 0` |
| `Sr` | `Instrument Serif` | `Regular` | None |
| `Si` | `Instrument Serif` | `Italic` | None |
| `Mr` | `JetBrains Mono` | `Regular` | None |
| `Mm` / `Ms` | `JetBrains Mono` | `Medium` | None |

## 3. Zero-Sass CSS Modules Bundling (`enforce: 'pre'`)

When a React/Storybook project uses `.module.scss` files with `@use`/`@include` mixins and `sass-embedded` is unavailable in the environment:
1. Register a Vite plugin with `enforce: 'pre'` that resolves `.module.scss` to `\0scssmod:<path>.js` so Vite's internal `vite:css` plugin never invokes `sass-embedded`.
2. Expand `@include` mixins and convert `.className` selectors into scoped `.Comp_className_hash` rules using native CSS nesting (supported natively in headless Chromium 120+).
3. Emit a single combined CSS file (`z-extra-stories-bundle.css`) alongside the ES module bundle (`extra-stories-bundle.js`).
