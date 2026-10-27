# Preserve Instagram's own comments drawer

The user supplied IMG_0538.PNG after reporting limited comments scrolling,
partial downward movement, an unusable top drag handle, and a drawer that would
not expand normally. The screenshot shows a large empty area between the top
grip and Comments heading. It does not reveal Instagram's exact DOM structure.

Vigil still forced every marked comments node into a fixed 52dvh box, cleared
its transforms, and replaced overflow. In a transformed native drawer this can
position an inner content section relative to the drawer instead of the viewport.
The earlier selector could mark that inner section while excluding the top grip,
or mark both inner and outer nodes when dialogs were nested. Forcing `touch-action:
auto` on the grip could also hand a drag back to browser scrolling before the
site's pointer-driven dismissal completed.

## Correction

- Remove the fixed position, height/max-height, transform, and overflow overrides
  from document-start styling, the production adapter, and the retained reference.
  Instagram owns the drawer's layout, expansion, scrolling, and dismissal.
- Preserve touch-action inside the drawer, including the site's `none` on a
  pointer-driven grip. The separate ancestor-path exception and contained
  overscroll remain; the comments root is no longer forced to be a scroll view.
- Extend a verified title/composer panel to its complete positioned/transformed
  drawer, including the grip, without including the surrounding media viewer.
  Collapse duplicate nested markers into one root. Transparent or dim full-screen
  backdrops and containers with `pointer-events: none` cannot become that root.
  An opaque drawer can expand to fill the viewport.
- Keep the native and JavaScript background pan boundaries, shared-item route
  containment, and media-source checks active.

## Verification

The new iOS WebKit fixture includes both anonymous and dialog-marked drawers,
a transformed outer drawer, a separate grip, flex content/list/composer children,
and a dim full-screen portal. It loads both production document-start and
document-end scripts. The previous implementation failed the layout/gesture
regression. The correction preserves the site's original measured geometry,
overflow and transform; includes the grip in the native exception while excluding
the exposed Reel; reaches the last comment; expands to the full viewport; reaches
newly loaded comments; and closes with a complete top-grip drag. Closing removes
the native exception. Background swipes and Next remain blocked.

All 21 selected iOS tests passed, with no failures or skips. The runtime build,
lint (503 sources), the three social build/container/route runtime test files,
and whitespace checks passed. The prior half-height test now checks preservation
of a site-provided bottom sheet instead of requiring Vigil to force that layout.
Test-host snapshots were black, so no visual screenshot comparison is claimed.

## Phone delivery

The last receipt records app 0.3.204 (207), deployed at 18:08 Eastern on October 27,
before this correction. The paired phone was unreachable during this follow-up.
The user has already said they will connect it later. Installation must use the
normal `npm run agent:update:social` verified app-and-policy transaction, followed
by inspection and real scrolling/expansion/dismissal checks on the phone. No
supervision, profile, signing, watchdog, or policy setting changed in this repair.
