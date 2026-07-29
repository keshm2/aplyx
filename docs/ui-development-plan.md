# aplyx desktop UI development plan

This document captures the next major UI refinement pass for the desktop app.
It exists so the visual/product direction is durable and does not depend on
scratch research notes.

## Purpose

The desktop app already works, but it still needs a more polished, more
pleasant, more modern feel before beta.

The goal of this phase is not to redesign the product from scratch. It is to
turn the current app into something that feels:

- smooth
- premium
- calm
- easy to use
- visually intentional instead of technically functional

## Inputs and references

This plan is based on:

- the current desktop app structure in `src/tauri/`
- the current Tauri + React direction already chosen for the app
- the user's request for a smoother, more aesthetic app
- a Zoom-adjacent color sensibility
- the dashboard reference image:
  `cdn.dribbble.com/userupload/17730953/file/original-05a2f18aae02857f16dc660924a28639.png`

## Design goals

The app should feel like a real product, not a tool stitched together from
working screens.

### Core goals

1. **Smoothness first**
   - no hard route swaps
   - no abrupt list/detail state changes
   - no jarring loading emptiness
   - transitions should help orientation, not draw attention to themselves

2. **Dashboard with hierarchy**
   - Home should feel like a real dashboard
   - Jobs / Review / History / Resumes should feel like work surfaces, not
     cloned placeholder layouts
   - navigation should be stable and always clear

3. **Better color discipline**
   - default theme should be calmer and more broadly appealing
   - current violet/beige look stays available as an option
   - status colors remain semantic, never decorative

4. **Typography stays stable for now**
   - current fonts remain the implementation default
   - future font directions are documented below, but not part of the first
     pass

## Immediate UI phase: Phase 14C

This should be treated as the next immediate UI-focused phase after the
current ATS/source expansion work, before beta.

Name:

- **Phase 14C — Desktop UI refinement and theming**

Intent:

- polish the existing desktop app rather than adding an entirely new surface
- keep the current app structure and make it feel finished

## Scope of the phase

### 1. Shell and dashboard refinement

Refine the app shell so it feels more like a premium desktop app.

Work:

- stabilize the left navigation as a true app rail
- improve spacing, panel hierarchy, and card grouping on Home
- make Home the only true dashboard view
- make Jobs / Review / History / Resumes more task-oriented and less widget-like
- reduce visual noise and card clutter

The guiding principle is:

- **fewer, larger, more meaningful sections**
- not many equal-weight boxes

### 2. Motion and transitions

The app should never feel static or jarringly mechanical.

Required motion behavior:

- shell-level route transitions for tab changes
- calm list/detail transitions
- loading states that hold layout rather than blink or pop
- wizard steps that move with a clear forward/backward sense
- reduced-motion support respected everywhere

Preferred motion language:

- short opacity + 4-8px directional movement
- 150-220ms for most transitions
- slightly faster exit than entrance
- no showy scaling, bouncing, or dramatic blur

Things that should remain immediate:

- nav selection affordance
- hover/focus states
- small control interactions
- toggles and buttons that would feel laggy if animated too much

### 3. Color system refresh

The current palette should remain available, but not necessarily as the
default.

#### Default recommendation

- **Calm Cobalt**

Characteristics:

- light mode: white / blue-tinted surfaces / cobalt action color / deep navy
  structure
- dark mode: deep graphite/navy base with cool blue accents
- neutral-first surfaces with one strong primary accent

This is the strongest match to the requested Zoom-like, broadly appealing,
premium productivity-app feel.

#### Alternate themes to support

1. **Sage Slate**
   - quieter, softer, less brand-blue energy

2. **Aplyx Classic / Legacy Violet**
   - preserves the current warm beige + violet/plum family
   - available as a user-selectable theme, not the only identity

3. **Graphite Cyan**
   - more technical / ops-console feeling
   - optional, not the primary consumer-facing default

#### Theme-system requirements

- all theme families must map to the same token contract
- status colors remain semantic (`good`, `warn`, `danger`)
- accent should be used for:
  - active nav state
  - focus rings
  - primary CTAs
  - selected surfaces in moderation
- accent should **not** be used to communicate success/warning/error

### 4. Dashboard layout direction

The reference image should influence the app in these ways:

- stable left rail
- strong top-level content framing
- cleaner dashboard composition
- fewer but clearer cards
- more breathing room
- one clear accent family instead of many competing colors

Recommended per-screen structure:

- **Home**
  - summary cards
  - next recommended action
  - queue / run health
  - recent meaningful activity

- **Jobs**
  - full-width search and source controls
  - list + detail split
  - strong loading and source-status feedback

- **Review**
  - queue-first workflow with obvious decision path

- **History**
  - data-first table/list with richer detail drawer/panel

- **Resumes**
  - document list + preview/conversion state

- **Settings**
  - grouped forms, narrow readable layout, no dashboard treatment

### 5. Font direction (future, not immediate)

Current fonts should stay as-is for now.

But for future exploration, the best directions are:

- **Inter**
  - strong for dense product UI and tabular/data-heavy views

- **Geist**
  - already aligned with a modern technical-product feel

- **IBM Plex Sans / Mono**
  - stronger enterprise/analytical tone

- **Atkinson Hyperlegible Next**
  - accessibility/readability-first option

Avoid for the app shell:

- decorative serif-heavy body UI
- narrow or trendy display grotesks in dense tables/forms
- novelty fonts without strong numeral readability

## Implementation priorities

### Priority 1

- real shell route transitions
- loading-state layout hold
- dashboard spacing/hierarchy cleanup

### Priority 2

- full theme-family support in settings
- Calm Cobalt default
- Legacy Violet preserved as selectable option

### Priority 3

- per-screen layout polish (Jobs / Review / History / Resumes)
- animation consistency audit

### Priority 4

- future typography refresh exploration

## Acceptance criteria

- [ ] desktop route changes feel smooth, not static or abrupt
- [ ] loading states preserve layout and reduce perceived jank
- [ ] Home reads as a real dashboard, not a temporary summary page
- [ ] Jobs / Review / History / Resumes feel like distinct work surfaces
- [ ] Calm Cobalt ships as the default visual theme
- [ ] current violet/plum theme remains available as a named option
- [ ] reduced-motion behavior is respected across transitions
- [ ] no transition added makes the app feel slower or less responsive

## What this phase should not do

- no full redesign of the information architecture
- no font replacement as part of the first pass
- no decorative animation for its own sake
- no introducing many new visual metaphors at once
- no expanding scope into unrelated product/backend work

## Relationship to other work

- This phase sits after the current ATS/source-expansion work and before beta
  polish.
- It complements, but does not replace, the product positioning work in
  `docs/product-positioning-and-rebrand-plan.md`.
- It should be treated as the primary durable reference for future desktop UI
  polish work.
