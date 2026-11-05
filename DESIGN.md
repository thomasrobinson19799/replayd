---
name: replayd
description: A compact developer triage workbench with calm surfaces and clear evidence.
colors:
  accent: "#245bd7"
  accent-soft: "#e8efff"
  canvas: "#f3f5f8"
  surface: "#ffffff"
  surface-soft: "#edf1f6"
  ink: "#172538"
  muted: "#526277"
  line: "#cfd7e3"
  danger: "#b42335"
  success: "#19633e"
  warning: "#805400"
  dark-accent: "#93b6ff"
  dark-accent-soft: "#253b61"
  dark-canvas: "#101720"
  dark-surface: "#17212e"
  dark-surface-soft: "#202d3d"
  dark-ink: "#e7eef8"
  dark-muted: "#a8b7ca"
  dark-line: "#3b4b60"
  dark-danger: "#ff9aab"
  dark-success: "#8ddbb1"
  dark-warning: "#efc274"
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
  card: "10px"
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
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
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
---

# Design System: replayd

## Overview

**Creative North Star: "Developer triage workbench"**

replayd is a compact, calm workbench for following recorded evidence. Cool neutral surfaces, clear blue actions and restrained severity colors keep dense debugging information readable. Familiar sidebar navigation, project cards and tables support the owner's chosen product language.

The interface carries a developer from project to issue, event, replay and resolution. A persistent workspace frame establishes location while the main area focuses on the current task. Settings and account screens share the same controls, spacing and material character. The visual authority is the built dashboard, especially `dashboard/app/assets/css/main.css`, its shared UI components and layout; product purpose is recorded in `PRODUCT.md`.

**Key Characteristics:**

- Compact, readable information density.
- Cool surfaces with subtle borders.
- Blue actions and explicit semantic severity.
- System typography and conventional controls.
- Equivalent light and dark themes.

## Colors

### Primary

**Workbench blue** (`accent`) identifies primary actions, active navigation, selected tabs and activity traces. **Pale blue** (`accent-soft`) supports selected surfaces without overwhelming their text. Their dark counterparts keep the same meaning with a lighter accent and deeper selected surface.

### Neutral

**Cool canvas** is the application background. **Surface** holds cards, navigation, forms and dialogs. **Soft surface** distinguishes headers, quiet fills and hover states. **Ink** carries primary text; **muted** carries supporting text; **line** separates adjacent content. Frontmatter keys prefixed with `dark-` are the corresponding values selected by the root theme attribute, not an additional accent palette.

### Semantic

Danger, success and warning identify error, resolved/successful and caution states. Always accompany severity with readable text or another explicit cue. Error and disabled badges use danger text; neutral badges use muted text on a soft surface.

The sidecar's tonal strips are generated previews for inspecting each color; they do not add application tokens or prescribe additional UI colors.

**The Paired Theme Rule.** Change text, backgrounds and borders together through semantic tokens. Primary actions use white text in light mode and dark canvas text in dark mode; inspect both states rather than assuming a text utility remains readable.

## Typography

The Segoe UI stack supplies both headings and body copy. It feels familiar and direct, with enough weight distinction for scanning dense records. There is no separate display typeface. Code retains the browser's monospace treatment.

- **Headline:** page heading; the headline token reduces to a compact size (23px) below the mobile breakpoint.
- **Title:** section heading; project names use a slightly larger title (19px).
- **Body:** default reading and table content.
- **Label:** field labels; buttons use a stronger weight (600), and hints, badges and supporting metadata use a smaller size (12px).
- **Measured values:** project statistics use larger numerals (26px), medium weight (600) and tabular figures.

Settings explanations are bounded to a readable measure (70ch). Empty-state descriptions use a shorter measure (50ch). Long technical strings wrap or scroll within their own region instead of widening the page.

## Layout

The desktop frame uses a fixed sidebar (220px), a bordered topbar with breadcrumbs and account actions (minimum height 70px), and a centered workspace (maximum width 1800px). The workspace uses the named workspace padding. Page headings place title/context and relevant actions together, wrapping when space becomes constrained.

At the intermediate breakpoint (1100px), the sidebar narrows (190px) and workspace padding decreases (24px). At the mobile breakpoint (760px), the workspace loses its left offset and uses compact padding (20px vertically, 16px horizontally). A toggle reveals the overlay sidebar (240px); the closed sidebar is hidden from interaction. Forms switch from two columns to one, headings wrap and topbar spacing tightens.

Project cards use an auto-filling grid with a minimum card width (320px, capped at the available width). Shared form grids use equal columns and the form-gap token. Tables keep their own horizontal and vertical scrolling region (maximum height 70vh), with sticky headings and readable non-wrapping column labels. Do not shrink technical values to avoid scrolling.

Replay workspaces preserve the recording's aspect ratio and fit the stage to its available region. Controls and detail tabs wrap as necessary; recorded breadcrumb entries align time, content and trailing metadata in columns. Filter and search controls remain close to the records they affect.

## Elevation & Depth

The workbench uses tone and fine borders for everyday separation. Cards and tables are flat. The shared shadow is reserved for dialogs, dropdowns, toasts and the revealed mobile navigation. Light and dark shadow values live in the sidecar because the frontmatter schema has no elevation group. Modal backdrops dim the surrounding task context.

**The Overlay Depth Rule.** Use a shadow to identify a surface above the current task, not to decorate each content card.

## Shapes

Rounded rectangles form a modest hierarchy: compact badges, subtly rounded controls, grouped panels, cards and then dialogs. The frontmatter radius tokens are normative. Borders are thin (1px) and use the semantic line color. Icons accompany labels with clear strokes; selected navigation preserves accent contrast.

## Components

### Buttons

Compact and direct. All four shared variants use a minimum height (36px), compact spacing, strong text (13px, weight 600) and the control radius. Primary is blue; secondary is a bordered surface; danger retains the surface with semantic danger text; ghost removes its resting border and fill. Secondary and ghost hover use the soft surface. Primary hover slightly darkens through brightness (0.93). Busy buttons show a small spinner and disable repeat submission.

Focus uses a visible accent outline (2px, offset 3px). Disabled controls use reduced opacity (0.5) with an unavailable cursor. State changes are brief (120ms); loading animation is limited to skeletons and spinners. Reduced-motion preferences remove animations and transitions.

### Inputs and fields

Inputs, selects and textareas share a bordered surface, control radius and minimum height (38px). A visible label sits above each shared field; hint or error text follows it and is programmatically associated. Invalid fields use the danger border and text. Preserve native checkbox and select behavior. Search remains an ordinary focusable input, including the device search in session filtering.

### Navigation and tabs

Sidebar items use muted resting text, a soft hover and an accent selected surface. Breadcrumbs describe the current hierarchy. The account dropdown groups account actions. The theme control cycles system, light and dark. Topbar tooltips appear below the control so they remain inside the viewport; tooltips also appear on keyboard focus.

Tabs use a bottom divider and accent underline for selection. Settings tabs wrap to keep the selected section visible at narrow widths. Only the selected shared tab is in the tab order; arrows, Home and End change selection. The shell includes a skip link, page-search shortcut and discoverable keyboard help.

### Cards, badges and tables

Cards group a complete unit of information using the card token and a thin border. Project cards separate name, measured activity and footer action; activity must come from real project data. Badges provide compact, explicit state labels.

Tables use soft header surfaces, muted strong headings and consistent cell padding (13px vertically, 16px horizontally). Hover and focus-within reveal the current row. Sort controls expose the actual ascending or descending direction. Navigation starts from an explicit link or button; arrow keys and j/k move focus between supported rows. Large datasets remain paginated or virtualized according to their screen, with bounded rendering.

### Dialogs and feedback

Dialogs use the native modal element, labelled titles, an explicit close action, Escape handling and restored focus. Width is bounded (560px or the viewport minus 32px), height is constrained (85vh), and content scrolls. Action groups sit at the end of the form.

Toasts sit at the lower-right edge and use inverted ink/surface colors. Empty states state the absence of records and, where available, a meaningful next action. Skeletons indicate pending content without inventing records. Replay controls, errors and recording gaps continue the same surface and typography language.

## Do's and Don'ts

### Do:

- Do reuse semantic tokens and shared controls across triage, replay, settings and account screens.
- Do inspect text, borders, icons and surfaces together in both themes.
- Do preserve readable table values with local scrolling and persistent headings.
- Do keep keyboard focus visible and actions reachable through native controls.
- Do use actual recorded activity and explicit loading, empty and error states.
- Do check desktop, intermediate and mobile layouts with real pointer and keyboard interactions.

### Don't:

- Don't introduce a new accent or display font for a single screen.
- Don't apply content-card shadows as general decoration.
- Don't leave an offscreen navigation panel focusable when closed.
- Don't hardcode sample business records into the interface.
- Don't treat clipped controls, stale sort indicators or unreachable actions as design conventions.
