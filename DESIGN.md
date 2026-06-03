# Questtick — Design System

Single source of truth for tokens, CSS classes, and conventions.

## Principles

- **Tokens, not hex** — every colour, size, radius, shadow must come from `tokens.css`
- **×2 rule** — all numeric values are multiples of 2 (spacing, sizes, radii, heights)
- **No new classes without a reason** — extend existing classes before adding new ones
- **Dark mode is automatic** — tokens flip via `prefers-color-scheme`; manual override via `data-theme="dark"|"light"` on `<html>`
- **Icons via `icon(name, size?)`** — never inline SVG for standard Lucide icons

---

## File Structure

```
src/
  styles.css          ← main app entry  (@import tokens + base + layout + components)
  auth.css            ← auth pages entry (@import tokens + auth)
  design/
    tokens.css        ← ALL tokens (colours, spacing, type, radii, heights, shadows)
    base.css          ← reset, body, scrollbar
    layout.css        ← topbar, metrics, cards grid, sort bar, mobile media queries
    components.css    ← buttons, pills, popups, overlays, panels, FV, briefing
    auth.css          ← auth card, inputs, buttons, divider, status pages
```

Never import design files directly from JS. Always go through `styles.css` or `auth.css`.

---

## Design Tokens (`src/design/tokens.css`)

### Typography

| Token | Value | Usage |
|---|---|---|
| `--font-family` | `'Manrope', Arial, sans-serif` | All text |
| `--text-2xs` | `10px` | Badges, uppercase labels |
| `--text-xs` | `12px` | Notes, secondary meta |
| `--text-sm` | `14px` | Buttons, inputs, body |
| `--text-base` | `16px` | Card tickers, popup titles |
| `--text-lg` | `18px` | Vol label, large numbers |
| `--text-xl` | `20px` | Metric card values, MS verdict |
| `--text-2xl` | `22px` | Large headings |
| `--text-3xl` | `26px` | Hero numbers |
| `--font-normal` | `400` | — |
| `--font-medium` | `500` | — |
| `--font-semi` | `600` | — |
| `--font-bold` | `700` | — |
| `--leading-tight` | `1.2` | — |
| `--leading-normal` | `1.4` | — |
| `--leading-relaxed` | `1.6` | — |

### Spacing

| Token | Value | Token | Value |
|---|---|---|---|
| `--space-1` | `2px` | `--space-10` | `20px` |
| `--space-2` | `4px` | `--space-12` | `24px` |
| `--space-3` | `6px` | `--space-16` | `32px` |
| `--space-4` | `8px` | `--space-20` | `40px` |
| `--space-5` | `10px` | `--space-24` | `48px` |
| `--space-6` | `12px` | `--space-32` | `64px` |
| `--space-7` | `14px` | | |
| `--space-8` | `16px` | | |

### Border Radius

| Token | Value | Usage |
|---|---|---|
| `--radius-sm` | `4px` | Small chips, tags |
| `--radius-md` | `8px` | Buttons, small cards |
| `--radius-lg` | `12px` | Cards, dropdowns |
| `--radius-xl` | `16px` | Popups, overlays, panels |
| `--radius-full` | `9999px` | Pills, circles |

### Heights

| Token | Value | Usage |
|---|---|---|
| `--h-btn-sm` | `26px` | Small inline action buttons |
| `--h-btn-md` | `30px` | Topbar buttons, popup controls |
| `--h-btn-lg` | `36px` | Account row buttons |
| `--h-btn-xl` | `40px` | Primary CTA buttons |
| `--h-input` | `40px` | Form inputs |
| `--h-input-lg` | `44px` | Modal form elements |

### Shadows

| Token | Usage |
|---|---|
| `--shadow-sm` | Cards, panels (light: `rgba(26,26,26,.08)`, dark: `rgba(0,0,0,.6)`) |
| `--shadow-md` | Popups, dropdowns (light: `.12`, dark: `.4`) |
| `--shadow-lg` | Elevated overlays (light: `.14`, dark: `.5`) |
| `--shadow-soft` | Alias for `--shadow-sm` — prefer `--shadow-sm` directly |

### Colours — Surface

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--canvas` | `#ffffff` | `#121517` | Page bg, chart bg |
| `--paper` | `#ffffff` | `#181d21` | Card / popup surface |
| `--cloud` | `#f7f7f7` | `#0a0d0f` | Section bg, hover fills |
| `--fog` | `#e8e8e8` | `#1e252a` | Muted fills, secondary controls |

### Colours — Border

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--hairline` | `#e8e8e8` | `#252d33` | Dividers, card borders |
| `--steel` | `#c2c2c2` | `#2d3940` | Input borders, scrollbar |

### Colours — Text

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--ink` | `#1a1a1a` | `#e3eaed` | Primary text |
| `--ink-deep` | `#000000` | `#f2f6f8` | Maximum contrast |
| `--on-ink` | `#ffffff` | `#121517` | Text on dark/filled surfaces |
| `--charcoal` | `#3d3d3d` | `#a8b5bb` | Secondary text |
| `--graphite` | `#636363` | `#637880` | Muted / placeholder text |

### Colours — Brand

| Token | Value | Usage |
|---|---|---|
| `--primary` | `#024ad8` | CTA, links, focus rings |
| `--primary-bright` | `#296ef9` | Hover state |
| `--primary-deep` | `#0e3191` | Active / pressed |
| `--primary-soft` | `#c9e0fc` | Light tint for badges |

### Colours — Semantic

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--bullish` | `#16a34a` | unchanged | Positive % change, profit |
| `--bullish-bg` | `#f0fdf4` | `rgba(22,163,74,.15)` | Banner background |
| `--caution` | `#b45309` | unchanged | Warning state |
| `--caution-bg` | `#fffbeb` | `rgba(180,83,9,.15)` | Caution background |
| `--danger` | `#dc2626` | unchanged | Destructive actions |
| `--danger-soft` | `#ef4444` | unchanged | Alerts, clear buttons |
| `--error` | `#f08080` | unchanged | Form validation errors |
| `--success` | `#4caf7d` | unchanged | Connected / positive states |
| `--level` | `#f59e0b` | unchanged | Price levels, briefing active |
| `--level-deep` | `#d97706` | unchanged | Level deep accent |
| `--bloom-coral` | `#ff5050` | unchanged | Hot NATR |
| `--bloom-deep` | `#b3262b` | unchanged | Bearish signal |

### Colours — Status / Chart / Feedback

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--ws-on` | `#22c55e` | unchanged | WS connected dot |
| `--ws-off` | `#ef4444` | unchanged | WS disconnected dot |
| `--chart-level` | `#277cc2` | unchanged | Price level lines |
| `--candle-up` | `#242424` | `#c2ccd0` | Bullish candle |
| `--candle-dn` | `#9badb8` | `#3b4b54` | Bearish candle |
| `--retry-bg` | `#fff1f1` | `rgba(179,38,43,.12)` | Error banner bg |
| `--retry-border` | `#fca5a5` | `rgba(179,38,43,.4)` | Error banner border |
| `--badge-ok-bg` | `#1a3a1a` | unchanged | Verified badge bg |
| `--badge-warn-bg` | `#3a2a1a` | unchanged | Warning badge bg |
| `--delete-bg` | `#5a1a1a` | unchanged | Destructive confirm bg |
| `--delete-bg-hover` | `#7a2a2a` | unchanged | Destructive confirm hover |
| `--caution-line` | `#fde68a` | unchanged | Caution border, inplay pill |

---

## Dark Mode

Tokens flip automatically. Manual override:

```html
<html data-theme="dark">   <!-- force dark -->
<html data-theme="light">  <!-- force light -->
```

If you add a token that needs a dark value — add it to **both** blocks in `tokens.css` (the `@media` block and the `[data-theme="dark"]` block) and keep them in sync.

Auth pages do **not** force a theme — they adapt to system preference.

---

## Opacity Tints

Use `color-mix()` instead of hardcoded `rgba()`:

```css
/* ✅ */
background: color-mix(in srgb, var(--danger-soft) 10%, transparent);

/* ❌ */
background: rgba(239, 68, 68, 0.1);
```

---

## CSS Classes

### `layout.css` — Structure

| Class | Notes |
|---|---|
| `.topbar` | Main nav bar: paper bg, shadow, 20px/32px margins |
| `.filters` | Filter bar inside topbar |
| `.filters-right` | Right-aligned filters group |
| `.metrics` | Auto-fit grid row (min 160px cols) |
| `.metric-card` | Individual metric: paper bg, shadow, 20px/24px padding |
| `.cards-area` | Card grid wrapper (0 32px 64px padding) |
| `.cards-sort` | Sort controls row |
| `.cards-grid` | 3-col card grid → 1-col on mobile |
| `.coin-card` | Individual coin card, paper bg, 16px radius |
| `.card-head` | Card header 36px, canvas bg |
| `.card-sym` | Symbol name 16px/700, `cursor:pointer` |
| `.stat-val` | Stat value: `.up` `.dn` `.hot` `.warn` `.dim` modifiers |
| `.chart-container` | 3:2 aspect ratio chart area |
| `.sort-bar` | Bottom sort bar |
| `.error-banner` | Inline error banner (retry-bg) |
| `.empty-state` | Empty list placeholder |
| `.fv-mob-actions` | Mobile FV actions row (hidden on desktop) |

### `components.css` — Buttons (base `button`)

Base `button` inherits: `var(--font-family)`, 14px, weight 500, h=40px, radius 8px.

| Class | Size | Notes |
|---|---|---|
| `.btn-refresh` | h=40 | Canvas bg, ink border |
| `.btn-settings` | 40×40 | Icon-only, fog bg |
| `.btn-tv` | h=40 | TradingView, fog bg |
| `.btn-theme` | 40×40 | Theme toggle, fog bg |
| `.btn-topbar` | 30×30 | Topbar icon buttons, fog bg |
| `.btn-expand` | 26×26 | Transparent, graphite → ink hover |
| `.btn-burger` | 36×36 | Mobile-only, round, fog bg |
| `.btn-avatar` | 30×30 | Circle, fog bg; `.has-emoji` variant |
| `.btn-star` | 24×24 | Transparent; `.active` = level fill |
| `.btn-briefing` | 40×40 | Fog bg; `.active` = level bg |
| `.btn-fv-star` | 28×28 | Fog bg, FV panel |
| `.btn-analyze-one` | 32×26 | Fog bg, inline analysis trigger |
| `.btn-retry` | h=26 | Retry state, retry-bg/bloom-deep |
| `.btn-pressed` | 32×26 | Disabled-progress state |
| `.btn-clear-alerts` | h=26 | Danger-soft tinted pill |
| `.btn-clear-levels` | h=26 | Level-tinted pill |
| `.btn-clear-both` | 26×26 | Transparent, fog hover |
| `.fv-back-btn` | 30×30 | Back nav, fog bg |

### `components.css` — Pills & Badges

| Class | Notes |
|---|---|
| `.filter-pill` | Round h=30; `.active` = ink bg |
| `.nav-pill` | Navigation pill, transparent bg |
| `.sort-pill` | Sort option, h=28 |
| `.tier-badge` | Tier label, ink bg pill |
| `.tier-num-btn` | Tier number toggle, h=26 |
| `.tf-pill` | TF picker trigger, h=22 |
| `.nav-beta-tag` | "BETA" uppercase, danger-soft |
| `.signal-badge` | `.bullish` / `.caution` / `.neutral` |
| `.ms-oi-badge` | OI status: `.up` / `.down` / `.neutral` |
| `.ms-inplay-pill` | Caution pill with caution-line border |
| `.acc-badge` | Email status: `.acc-badge-ok` / `.acc-badge-warn` |
| `.bp-trade-pill` | Trade result: `.bp-trade-pos` / `.bp-trade-neg` / `.bp-trade-none` |
| `.clear-count` | Inside clear-popup: `.clear-count--level` / `.clear-count--alert` |

### `components.css` — Dropdowns & Menus

| Class | Notes |
|---|---|
| `.tf-dd` | TF dropdown, `display:none` by default; JS shows it |
| `.burger-dd` | Mobile menu; `.open` shows it |
| `.avatar-dd` | Avatar dropdown; `.open` shows it |
| `.clear-popup` | Alert/level clear popup |

### `components.css` — Popups & Overlays

| Class | Notes |
|---|---|
| `.popup-header` | Flex: gap 8, padding 16px 12px 0 |
| `.popup-title` | 15px/700, ink |
| `.popup-close` | 30×30 fog bg close btn |
| `.popup-body` / `.popup-footer` | Standard popup padding |
| `.popup-btn` | Full-width popup action button |
| `.analysis-overlay` | AI analysis floating card |
| `.code-modal-backdrop` | Full-screen modal (`rgba(0,0,0,.55)`) |
| `.code-modal` | Centred modal card, 360px max |
| `.account-overlay` | Full-screen account settings |
| `.tv-overlay` | Full-screen TV grid |
| `#fv-overlay` | Full-screen single-chart view |

### `components.css` — Full View (FV)

| Class | Notes |
|---|---|
| `.fv-body` | Flex column container |
| `.fv-chart-wrap` | Chart area, fills space |
| `.fv-coin-info` | Top-left coin info block |
| `.fv-info-top` | Symbol + actions row (hidden on mobile) |
| `.fv-sym-label` | Symbol 16px/700, `cursor:pointer` |
| `.fv-bottom-bar` | Mobile bottom controls |
| `.fv-vol-label` | Volume label overlay |
| `.fv-add-btn` | Add level/alert floating btn |
| `#fv-briefing-drawer` | Side briefing drawer; `.open` = 360px |

### `components.css` — Market Strength

| Class | Notes |
|---|---|
| `.ms-panel` | Panel wrapper, paper bg |
| `.ms-title` | Uppercase 11px label |
| `.ms-verdict-strong/medium/weak` | 22px/700 verdict text |
| `.ms-metrics-grid` | 2-col metric grid |
| `.ms-bar` / `.ms-bar-fill` | Progress bar; fill modifier: `.strong` `.medium` `.weak` |
| `.ms-popup` | Expanded MS popup (400px) |

### `components.css` — Briefing

| Class | Notes |
|---|---|
| `#bp-popup` | 360px briefing popup |
| `.bp-row` | Single coin row, hover bg |
| `.bp-sym-btn` | Symbol 13px/700 |
| `.bp-status` | Status icon btn: `.bp-s-none/watching/traded/skip/missed` |
| `.bp-note-btn` | Note toggle btn |
| `.bp-week` | Weekly summary section |
| `.bp-ai-block` | AI report section |
| `.bp-stat-card` | Stat card in weekly grid |

### `components.css` — Utilities

| Class | Notes |
|---|---|
| `.ws-indicator` | 8×8 circle: `.connected` `--ws-on`, `.disconnected` `--ws-off` |
| `.spinner` | 14×14 spin, inline |
| `.loading-overlay` | Full-page loading state |
| `.ruler-lbl` | Chart ruler label — `display:none` by default; JS sets `display:flex` |

### `design/auth.css` — Auth Pages

| Class | Notes |
|---|---|
| `.auth-card` | Centred form card, max 360px, paper bg |
| `.auth-title` | 22px/600, margin-bottom 28px |
| `.auth-error` | Error banner — `display:none` by default; show via JS |
| `#login-msg` | Success message — `display:none` by default; show via JS |
| `.auth-err-inline` | Inline field error, 12px, `--error`, min-height 18px |
| `.auth-ok` | Success text 14px, `--success` |
| `.auth-btn-primary` | Full-width primary btn, `--primary` bg |
| `.auth-btn-google` | Google OAuth btn — **fixed white bg (brand requirement)** |
| `.auth-btn-link` | Ghost link btn, graphite text |
| `.auth-divider` | "or" divider with flex lines |
| `.auth-status` | Status-only pages (verify-email, confirm-email-change) |
| `.auth-back` | Back link, graphite text |

---

## Conventions

### Adding a New Token

1. Add to `tokens.css` `:root {}` with a comment
2. If it needs a dark value — add to **both** dark blocks (media query + `[data-theme="dark"]`)
3. Value must be a multiple of 2 if numeric

### `popup-btn` Dark Override Pattern

Some buttons need different bg in dark mode. The pattern used in this codebase:

```css
.popup-btn { background: var(--canvas); }
html:not([data-theme="light"]) .popup-btn { background: var(--fog); }
html[data-theme="dark"] .popup-btn { background: var(--fog); }
```

Both selectors required to cover system preference and manual override.

### Hiding / Showing via JS

Classes that are `display:none` by default and shown by JS:
- `.tf-dd` — JS adds `display:block`
- `.auth-error`, `#login-msg`, `.auth-ok` — JS sets `style.display = 'block'`
- `.ruler-lbl` — JS sets `style.display = 'flex'`
- `#fv-overlay` — JS sets `display:flex`
- `.burger-dd`, `.avatar-dd` — JS toggles `.open` class

---

## Do Not

| ❌ | ✅ |
|---|---|
| Hardcode `#hex` in CSS | Use `var(--token)` |
| Use `rgba(hex, n)` | Use `color-mix(in srgb, var(--token) N%, transparent)` |
| Set `font-family` in individual classes | `button` base and `body` handle it |
| Add static `style=""` for visual props | Move to CSS class |
| Use `isDark()` in JS to set colours | Tokens handle light/dark automatically |
| Inline SVG for Lucide icons | Use `icon('name', size)` helper |
| Add shadows with raw `rgba()` | Use `var(--shadow-sm/md/lg)` |
| Use values not divisible by 2 | Pick nearest even number |
