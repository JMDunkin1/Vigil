# Cohesive traditional UI concepts

These are visual studies for making Vigil's controls feel as traditional as its
typography and sacred art. They intentionally preserve the current composition:

- the same dark sidebar shape and width
- the same navigation, labels, account area, and protection control
- the same brown-black, parchment, and muted-gold palette
- the same main background and sacred portrait

Only the control language changes: button silhouettes, icon frames, dividers,
active-tab treatment, and small ornamental details.

## Directions

1. **Illuminated Manuscript** — pointed cartouches, historiated-initial icon
   medallions, fine double rules, and a ceremonial parchment selected state.
2. **Gothic Choir Screen** — shallow ogee niches, quatrefoil icon frames,
   tracery-like rails, and a restrained rose-window gear.
3. **Renaissance Bookbinding** — blind-tooled leather tabs, clipped corners,
   brass bosses, engraved seals, and a vellum title-label selected state.
4. **Byzantine Iconostasis** — shallow arched niches, muted cloisonné roundels,
   bead-and-reel dividers, and a small gilded canopy for the active tab.
5. **Monastic Arts & Crafts** — chamfered plaques, escutcheon icons, parchment
   insets, corner straps, and simple carved or wrought-metal details.

## Prompt set

All five images used `current-vigil-reference.png` as an edit target with this
shared instruction:

> Create a high-fidelity desktop UI concept. Preserve the exact Vigil window
> composition, left sidebar size and silhouette, macOS traffic lights, title,
> navigation and account labels, central sacred portrait, level control,
> existing color palette, and existing background. Redesign only the controls,
> icon treatment, dividers, and active navigation state. Avoid modern pills,
> generic line icons, new colors, new features, fantasy-game styling, or changes
> to the sacred art and layout.

Each output then applied the corresponding direction above as its material and
ornamental vocabulary. The images were generated with the built-in image tool.

## Reading the studies

These are direction-finding mockups, not literal pixel specifications. The most
useful comparison is the shape and hierarchy of the left-rail controls. Once a
direction is chosen, its geometry can be rebuilt in HTML/CSS while reusing the
repository's original saint assets directly.
