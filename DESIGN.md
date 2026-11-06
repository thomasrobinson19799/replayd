---
name: "replayd"
description: "A compact evidence-first developer workspace with paired neutral themes and indigo actions."
colors:
  background: "#0d1017"
  card: "#151a23"
  muted: "#1e2531"
  muted-foreground: "#929eaf"
  border: "#29313e"
  foreground: "#edf1f7"
  primary: "#a5b4fc"
  success: "#4cdbad"
  destructive: "#fa8292"
  warning: "#e8b967"
  accent: "#6366f1"
  on-solid: "#ffffff"
  negative-button: "#be123c"
  light-background: "#eef1f6"
  light-card: "#ffffff"
  light-muted: "#f2f4f8"
  light-muted-foreground: "#626f83"
  light-border: "#e2e6ee"
  light-foreground: "#182338"
  light-primary: "#4f46e5"
  light-success: "#087d5a"
  light-destructive: "#c13d54"
  light-warning: "#98600c"
typography:
  headline:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "20px"
    fontWeight: 650
    lineHeight: 1.4
    letterSpacing: "-0.02em"
  title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "14px"
    fontWeight: 650
    lineHeight: 1.4
    letterSpacing: "-0.02em"
  brand:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "13px"
    fontWeight: 650
    letterSpacing: "-0.02em"
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "12px"
    fontWeight: 500
  table:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "12px"
    fontWeight: 400
  table-header:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "11px"
    fontWeight: 500
  hint:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
  stat:
    fontFamily: "ui-monospace, \"SFMono-Regular\", Consolas, monospace"
    fontSize: "20px"
    fontWeight: 600
  eyebrow:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "10px"
    fontWeight: 600
    letterSpacing: "0.1em"
rounded:
  inline: "4px"
  control: "6px"
  panel: "8px"
  navigation: "10px"
  dialog: "12px"
spacing:
  space-1: "4px"
  space-1-5: "6px"
  space-2: "8px"
  space-2-5: "10px"
  space-3: "12px"
  space-3-5: "14px"
  space-4: "16px"
  space-5: "20px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-solid}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
  button-secondary:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
  button-danger:
    backgroundColor: "{colors.negative-button}"
    textColor: "{colors.on-solid}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.panel}"
    padding: "10px 12px"
  navigation-active:
    textColor: "{colors.primary}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  badge:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.control}"
    padding: "2px 8px"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.panel}"
    padding: "16px"
  tabs:
    textColor: "{colors.muted-foreground}"
    padding: "10px 12px"
  evidence-section:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.panel}"
    padding: "12px"
---

# Design System: replayd

## Overview

**Creative North Star: "Evidence-first developer triage"**

replayd is a compact workbench for inspecting recorded errors and sessions. Cool neutral surfaces, indigo actions and explicit severity colors keep dense evidence readable. The owner-supplied compact design system replaces the former plum palette while retaining the familiar navigation, content hierarchy and interaction patterns.

The built source of truth is `dashboard/app/assets/css/main.css`, with Vue shared controls and the existing icon paths. Nuxt 4, Vue 3 and Tailwind 4 remain in place. System fonts and semantic tokens carry the same visual language through projects, triage, replay, settings, account and error screens.

**Key Characteristics:**

- Compact spacing and clear data hierarchy.
- Paired dark and light palettes with semantic severity.
- System sans text and monospace identifiers and measured values.
- Bordered surfaces with restrained elevation.
- Native controls, visible focus and reduced-motion support.

## Colors

Cool neutral surfaces frame one indigo action color and explicit semantic states. The frontmatter's unprefixed palette is dark; `light-` entries map the corresponding roles in light mode.

**Primary.** Accent supplies solid primary buttons and the brand mark. Primary supplies links, focus and selected navigation. Selection uses a restrained tint of primary (9%).

**Neutral.** Background is the page and input surface; card is the panel, header and dropdown surface; muted supports hover and quiet fills. Foreground and muted-foreground carry primary and secondary text. Border separates surfaces; soft dividers use it at 65%, and table hover uses muted at 60%.

**Semantic.** Success, destructive and warning retain their meaning across themes. Badges use tone text with 15% tone backgrounds. Toast borders use the corresponding tone at 40%. Neutral badges pair muted with muted-foreground.

**The Paired Theme Rule.** Change foreground, surface and border roles together. Primary action fill and white action text stay identical in both themes; links, focus and selection use the theme-specific primary color.

Dark is the CSS fallback. The existing persisted system/light/dark selector still applies `data-theme`; `.light` also selects the light palette. Set `color-scheme` to the resolved theme. Do not change the existing theme preference behavior.

## Typography

The system sans stack supplies interface prose and headings; the system mono stack supplies code, identifiers and tabular values. No downloaded font is used. The frontmatter records the implemented roles.

Page titles use the compact headline role (20px); this extends the panel-heading pattern where the supplied specification did not define page titles. Stat values reduce to 19px below 768px. Brand text uses the smaller brand role; panel headings retain weight 650 and tight tracking. Labels and badges are 12px, table headings and hints 11px, and navigation eyebrows 10px with uppercase presentation.

Inputs use 14px text, or 13px in compact filter and replay controls. All inputs, selects and textareas use 16px below 600px. Code text has a 10px floor. Body text is antialiased.

**The Measured Type Rule.** Use monospace with tabular numerals for identifiers, code and aligned measurements. Keep interface prose in the system sans stack.

## Layout

The desktop workspace retains a 220px fixed navigation rail and a centered content area capped at 1800px. The header has a 48px minimum height and 16px horizontal padding. Workspace padding is 8px 12px 12px; it becomes 8px 10px 10px below 1200px and 8px below 600px. Adjacent panels use an 8px gap.

Cards use 16px padding. Panel headings use 12px padding and 8px gaps. Shared form fields stack with a 12px gap, and labels sit 4px above inputs. Stat cells use 14px 16px padding, 8px internal gaps and thin dividers. Empty states use 40px vertical and 24px horizontal padding.

At 1199px the rail narrows to 190px. At 767px it becomes a 240px overlay beneath the header; the navigation toggle remains reachable. Forms and evidence columns stack. At 599px mobile field text grows and dense detail rows wrap. These correspond to the Tailwind min-width breakpoints 1200, 768 and 600px.

Tables scroll within their bordered container, capped at 70vh; headings stick to the top and button action cells stay reachable at the trailing edge. The replay stage retains the recording's aspect ratio and existing geometry.

**The Bounded Surface Rule.** Keep wide data and long technical strings inside their own scrolling or wrapping regions. Preserve table headings and reachable actions instead of shrinking values.

## Elevation & Depth

Thin borders separate ordinary surfaces. Cards add only the small card shadow. Dropdowns, dialogs and open mobile navigation use the larger overlay shadow; toast separation comes from a border. The sidecar records the exact shadow and motion values.

**The Quiet Depth Rule.** Use thin borders to separate surfaces. Keep the small card shadow and reserve the larger shadow for surfaces that sit above the current task.

## Shapes

Compact inline controls and count chips use the smallest radius. Buttons and badges use the control radius; inputs, panels and cards use the panel radius. Navigation containers use the navigation radius, while dialogs and large activity summaries use the dialog radius. Status dots and spinners are circular.

Shared icons retain the project's existing SVG paths, currentColor, round caps and joins, with a 16px default size and 1.8 stroke. Selected navigation icons remain opaque.

## Components

**Buttons.** Shared and legacy controls share a centered inline layout, 6px gap, weight 600 and 200ms state transitions. Primary is accent with white text; secondary is bordered with foreground text; ghost begins muted and gains foreground on hover. Danger uses the solid negative color with white text. Solid hover opacity is 90%. Disabled opacity is 50% with a not-allowed cursor. Standard padding is 6px 12px; table buttons use 4px 10px and 12px text.

**Fields.** Inputs use background fill, a 1px border, panel radius and 10px 12px padding. Focus has a 2px primary outline at the edge. Invalid fields use a destructive border and associated error text. Native selects retain their browser behavior, with card fill, control radius and 8px 12px padding. Compact fields have a 32px minimum height. Number spinners are hidden.

**Tabs and menus.** Tabs use a bottom divider, 10px 12px padding and a 2px primary active underline; active text is foreground. Counts use compact muted chips. Custom dropdown panels have bounded scrolling, card fill, a border, panel radius and overlay shadow. Menus enter over 120ms with opacity and a small upward offset; the account chevron rotates when open. Native select popups, including their arrows and option layout, remain browser/OS controlled.

**Cards, badges and tables.** Cards group existing records. Badges pair readable text with semantic tints. Tables use 12px normal text, 11px medium headers, tabular numerals and 8px 10px cell padding. Header height is 32px and ordinary cell height 34px, expanding for content. Borders and hover fills remain subtle.

**Feedback and focus.** Toasts sit at the top right, 8px apart, with 12px 16px padding and a 180ms opacity/vertical entrance. Keyboard focus elsewhere uses a 2px primary outline with 3px offset. Reduced-motion preferences reduce animation and transition durations to near zero. Coarse-pointer controls target 40px, navigation/menu rows 44px, and table cells 44px.

**Evidence and replay.** Native disclosures, the context rail, timeline markers and inspection tabs keep their existing behavior. Virtualized replay rows remain at their existing 24px geometry; meeting the larger touch-row target would require a separate behavior change. The replay iframe retains its white underlying canvas so recorded content is not recolored by the dashboard theme.

## Do's and Don'ts

### Do:

- Do reuse the central tokens and existing shared controls.
- Do inspect text, icons and their backgrounds together in both themes.
- Do preserve visible keyboard focus and test real pointer interactions.
- Do keep tables locally scrollable and technical identifiers readable.
- Do keep all displayed records, permissions and behaviors tied to the existing application.

### Don't:

- Don't add fonts, UI libraries or a replacement component framework for styling.
- Don't hardcode a separate palette or font stack for an individual page.
- Don't change routes, copy, API calls or data handling to make a visual change.
- Don't increase virtualized row height with CSS alone; its geometry is controlled by existing code.

