---
name: replayd
description: An evidence-first developer triage workspace with plum navigation and violet actions.
colors:
  accent: "#6941b5"
  accent-soft: "#eee7fb"
  canvas: "#f7f6f9"
  surface: "#ffffff"
  surface-soft: "#f0edf5"
  ink: "#302739"
  muted: "#665b75"
  line: "#d9d3e2"
  control-border: "#8b7d98"
  danger: "#b42335"
  success: "#19633e"
  warning: "#805400"
  dark-accent: "#c6a9ff"
  dark-accent-soft: "#3c2b54"
  dark-canvas: "#19151f"
  dark-surface: "#221c2a"
  dark-surface-soft: "#302639"
  dark-ink: "#f2edf7"
  dark-muted: "#c1b4ce"
  dark-line: "#50425e"
  dark-control-border: "#8f7b9e"
  dark-danger: "#ff9aab"
  dark-success: "#8ddbb1"
  dark-warning: "#efc274"
  sidebar-surface: "#2b2338"
  sidebar-surface-soft: "#3e314f"
  sidebar-ink: "#faf7ff"
  sidebar-muted: "#cfc2df"
  sidebar-line: "#665574"
  sidebar-accent: "#d3bbff"
  sidebar-accent-soft: "#493560"
typography:
  headline:
    fontFamily: '"Segoe UI", "Helvetica Neue", sans-serif'
    fontSize: "26px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  title:
    fontFamily: '"Segoe UI", "Helvetica Neue", sans-serif'
    fontSize: "17px"
    fontWeight: 650
  body:
    fontFamily: '"Segoe UI", "Helvetica Neue", sans-serif'
    fontSize: "14px"
    lineHeight: 1.55
  label:
    fontFamily: '"Segoe UI", "Helvetica Neue", sans-serif'
    fontSize: "13px"
    fontWeight: 550
rounded:
  badge: "4px"
  control: "6px"
  panel: "8px"
  card: "7px"
  settings: "10px"
  dialog: "12px"
spacing:
  field-gap: "6px"
  compact: "8px"
  control-gap: "12px"
  form-gap: "16px"
  card-gap: "20px"
  card-padding: "22px"
  panel-padding: "24px"
  workspace: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "7px 12px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "7px 12px"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.danger}"
    rounded: "{rounded.control}"
    padding: "7px 12px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "7px 12px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "8px 10px"
  navigation-active:
    backgroundColor: "{colors.sidebar-accent-soft}"
    textColor: "{colors.sidebar-ink}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  badge:
    backgroundColor: "{colors.surface-soft}"
    textColor: "{colors.muted}"
    rounded: "{rounded.badge}"
    padding: "2px 8px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "22px"
  tabs:
    textColor: "{colors.muted}"
    padding: "12px"
  evidence-section:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
---

# Design System: replayd

## Overview

**Creative North Star: "Evidence-first developer triage"**

replayd is a compact, calm workbench for following recorded evidence. Permanent plum navigation anchors neutral surfaces, violet actions and restrained severity colors. Familiar Sentry-like sidebar navigation, project cards, tables and grouped evidence panels express the owner's chosen developer-tool conventions.

The interface introduces the issue and its impact before resolution controls, then leads into event evidence and replay. A persistent workspace frame establishes location; evidence occupies the main column while a separate rail carries issue context. Settings, account and standalone error screens share the same typography, controls and theme behavior. The visual authority is the built dashboard, especially `dashboard/app/assets/css/main.css`, its shared UI components and layout; product purpose is recorded in `PRODUCT.md`.

**Key Characteristics:**

- Compact, readable information density.
- Plum navigation and neutral surfaces with subtle borders.
- Violet actions and explicit semantic severity.
- Evidence first, with progressively disclosed detail and a separate context rail.
- System typography and conventional controls.
- Equivalent light and dark themes.

## Colors

### Primary

**Workbench violet** (`accent`) identifies primary actions, selected tabs and activity traces. **Pale violet** (`accent-soft`) supports selection and the event-to-replay prompt without overwhelming their text. Their dark counterparts keep the same meaning with a lighter accent and deeper selected surface.

### Neutral

**Neutral canvas** is the application background. **Surface** holds cards, forms and dialogs. **Soft surface** distinguishes headers, quiet fills and hover states. **Ink** carries primary text; **muted** carries supporting text; **line** separates adjacent content. Frontmatter keys prefixed with `dark-` are the corresponding values selected by the root theme attribute, not an additional accent palette.

**Control border** gives editable inputs, selects and textareas a stronger visible boundary in each theme. Keep this role separate from the subtle `line` token used for decorative dividers. Invalid fields retain the danger border.

**Permanent plum navigation** uses the `sidebar-` token family in both themes. Its pale text, lavender focus accent and lighter plum selected fill are scoped to navigation. The current destination uses full-contrast sidebar ink and opaque icon strokes, including when a detail route is open.

### Semantic

Danger, success and warning identify error, resolved/successful and caution states. Always accompany severity with readable text or another explicit cue. Error and disabled badges use danger text; neutral badges use muted text on a soft surface.

The sidecar's tonal strips are generated previews for inspecting each color; they do not add application tokens or prescribe additional UI colors.

**The Paired Theme Rule.** Change text, backgrounds and borders together through semantic tokens. Shared primary buttons use white text in light mode and dark canvas text in dark mode; inspect both states rather than assuming a text utility remains readable. The sidebar keeps its own contrasting plum palette in either theme.

## Typography

The Segoe UI stack supplies both headings and body copy. It feels familiar and direct, with enough weight distinction for scanning dense records. There is no separate display typeface. Code retains monospace treatment; event messages explicitly use the system monospace stack.

- **Headline:** page heading; the headline token reduces to a compact size (23px) below the mobile breakpoint.
- **Issue title:** a compact technical heading (24px) that wraps long error text.
- **Title:** section heading; project names use a slightly larger title (19px).
- **Body:** default reading and table content.
- **Label:** field labels; buttons use a stronger weight (600), and hints, badges and supporting metadata use a smaller size (12px).
- **Measured values:** project statistics use larger numerals (26px), medium weight (600) and tabular figures.
- **Issue impact:** event and user counts use tabular numerals (28px, reducing to 23px on narrow screens); context-rail headings use compact section text (14px).

Settings explanations are bounded to a readable measure (70ch). Empty-state descriptions use a shorter measure (50ch). Long technical strings wrap or scroll within their own region instead of widening the page.

## Layout

The desktop frame uses a fixed sidebar (220px), a bordered topbar with breadcrumbs and account actions (minimum height 58px), and a centered workspace (maximum width 1800px). The workspace uses the named workspace padding at its sides and bottom, with a more compact top inset (24px). Page headings place title/context and relevant actions together, wrapping when space becomes constrained.

At the intermediate breakpoint (1100px), the sidebar narrows (190px) and workspace padding decreases (24px). At the mobile breakpoint (760px), the workspace loses its left offset and uses compact side and bottom padding (16px and 20px respectively), retaining the top inset. A toggle reveals the overlay sidebar (240px); the closed sidebar is hidden from interaction. Forms switch from two columns to one and headings wrap.

Issue detail places identity and impact above a full-width workflow row. Below it, a flexible evidence column sits beside a context rail (280px, narrowing to 230px at the intermediate breakpoint). At the evidence-stack breakpoint (900px), the rail moves below the evidence into a two-column context grid. At the narrow-evidence breakpoint (600px), the issue header stacks, panel padding tightens, tag values become a single column and breadcrumb timestamps move beneath their message. These rules describe the issue-detail pattern, not every screen.

Project cards use an auto-filling grid with a minimum card width (320px, capped at the available width). Shared form grids use equal columns and the form-gap token. Tables keep their own horizontal and vertical scrolling region (maximum height 70vh), with sticky headings and readable non-wrapping column labels. Do not shrink technical values to avoid scrolling.

Replay workspaces preserve the recording's aspect ratio and fit the stage to its available region. Controls and detail tabs wrap as necessary; recorded breadcrumb entries align time, content and trailing metadata in columns. Filter and search controls remain close to the records they affect.

## Elevation & Depth

The workbench uses tone and fine borders for everyday separation. Cards and tables are flat. The shared shadow is reserved for dialogs, dropdowns, toasts and the revealed mobile navigation. Light and dark shadow values live in the sidecar because the frontmatter schema has no elevation group. Modal backdrops dim the surrounding task context.

**The Overlay Depth Rule.** Use a shadow to identify a surface above the current task, not to decorate each content card.

## Shapes

Rounded rectangles form a modest hierarchy: compact badges, subtly rounded controls, evidence/card containers, grouped panels and dialogs. Settings panels retain their established larger radius. The frontmatter radius tokens are normative. Borders are thin (1px); decorative boundaries use the semantic line color, while editable fields use the stronger control-border token. Icons accompany labels with clear strokes; selected sidebar navigation preserves full foreground contrast.

## Components

### Buttons

Compact and direct. All four shared variants use a minimum height (36px), compact spacing, strong text (13px, weight 600) and the control radius. Primary is violet; secondary is a bordered surface; danger retains the surface with semantic danger text; ghost removes its resting border and fill. Secondary and ghost hover use the soft surface. Primary hover slightly darkens through brightness (0.93). Busy buttons show a small spinner and disable repeat submission.

Focus uses a visible accent outline (2px, offset 3px). Disabled controls use reduced opacity (0.5) with an unavailable cursor. Primary hover brightness changes are brief (120ms); foreground and background theme changes occur together. Loading animation is limited to skeletons and spinners. Reduced-motion preferences remove animations and transitions.

### Inputs and fields

Inputs, selects and textareas share a surface with the stronger control-border boundary, control radius and minimum height (38px). A visible label sits above each shared field; hint or error text follows it and is programmatically associated. Invalid fields use the danger border and text. Preserve native checkbox and select behavior. Search remains an ordinary focusable input, including the device search in session filtering.

### Navigation and tabs

Sidebar items use pale muted resting text, a lighter plum hover and a selected plum surface with full-contrast text. Breadcrumbs describe the current hierarchy. The account dropdown groups account actions. The theme control cycles system, light and dark; standalone error screens apply the same saved preference or system default. Topbar tooltips appear below the control so they remain inside the viewport; tooltips also appear on keyboard focus.

Tabs use a bottom divider and accent underline for selection. Settings tabs wrap to keep the selected section visible at narrow widths. Only the selected shared tab is in the tab order; arrows, Home and End change selection. The shell includes a skip link, page-search shortcut and discoverable keyboard help.

### Cards, badges and tables

Cards group a complete unit of information using the card token and a thin border. Project cards separate name, measured activity and footer action; activity must come from real project data. Badges provide compact, explicit state labels.

Tables use soft header surfaces, muted strong headings and consistent cell padding (13px vertically, 16px horizontally). Hover and focus-within reveal the current row. Sort controls expose the actual ascending or descending direction. Navigation starts from an explicit link or button; arrow keys and j/k move focus between supported rows. Large datasets remain paginated or virtualized according to their screen, with bounded rendering.

### Dialogs and feedback

Dialogs use the native modal element, labelled titles, an explicit close action, Escape handling and restored focus. Width is bounded (560px or the viewport minus 32px), height is constrained (85vh), and content scrolls. Action groups sit at the end of the form.

Toasts sit at the lower-right edge and use inverted ink/surface colors. Empty states state the absence of records and, where available, a meaningful next action. Skeletons indicate pending content without inventing records. Replay controls, errors and recording gaps continue the same surface and typography language.

### Issue evidence and workflow

Event details group the timestamp, previous/next event controls, recorded context and a clear replay action. Native disclosure sections organize stack trace and breadcrumbs; both begin open, with clear open/closed indicators. The adjacent rail separates issue dates, platform counts and tags from the event evidence. Labels and counts always reflect retained data.

Resolve, Ignore and reopen controls follow the issue's actual state and permissions. Ignore opens a bounded, scrollable option group; at the mobile breakpoint it enters document flow beneath the trigger rather than extending beyond the viewport. Escape restores focus to its trigger; clicking outside dismisses it. Custom date or event-count choices use the shared modal and validation patterns. Deletion remains an explicit confirmed action.

**The Evidence and Context Rule.** Establish issue identity and impact before workflow actions, then keep event evidence distinct from issue-level context. Use progressive disclosure to organize recorded detail without inventing unsupported features.

## Do's and Don'ts

### Do:

- Do reuse semantic tokens and shared controls across triage, replay, settings and account screens.
- Do inspect text, borders, icons and surfaces together in both themes.
- Do preserve readable table values with local scrolling and persistent headings.
- Do keep keyboard focus visible and actions reachable through native controls.
- Do use actual recorded activity and explicit loading, empty and error states.
- Do preserve the owner's Sentry-like conventions while exposing only replayd's real capabilities and permissions.
- Do check desktop, intermediate and mobile layouts with real pointer and keyboard interactions.

### Don't:

- Don't introduce a new accent or display font for a single screen.
- Don't apply content-card shadows as general decoration.
- Don't leave an offscreen navigation panel focusable when closed.
- Don't hardcode sample business records into the interface.
- Don't treat clipped controls, stale sort indicators or unreachable actions as design conventions.
