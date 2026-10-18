# Credits

## Echo Show wallpapers (`simulator/wallpapers/`)

The six ambient home-screen photos of the simulated Echo Show 15 and Echo Show 8 are original images
generated with Astra for this project (AI image generation, briefed and selected by the author, Blanco).
They are not stock photos and contain no people, text, logos or brands.

| File | Scene | Shown first from |
|---|---|---|
| `lake-dawn.webp` | Misty lake at dawn | 5 AM |
| `kitchen-morning.webp` | Sunlit kitchen in the morning | 7 AM |
| `snow-window-morning.webp` | Snowy fields through a window, warm cup | 9 AM |
| `garden-afternoon.webp` | Garden border in the afternoon | 12 PM |
| `living-room-golden-hour.webp` | Living room at golden hour | 4 PM |
| `reading-nook-dusk.webp` | Reading nook at dusk | 7 PM |

Each comes in two sizes (`1920/` for Echo Show 15, `1280/` for Echo Show 8), WebP, at most 233 KB.
They are released with the rest of this repository under the MIT license (see [LICENSE](LICENSE)).

## Item photos (`media/items/`)

The 17 thumbnails on the offers, plan and receipt cards, and the 34 extra views of the item card's photo gallery (6 home services, 4 bedding items, 4 dog foods,
3 coffees) are original images generated with Astra for this project, matching the fictional sandbox catalogue
(`src/core/catalog.mjs`, `src/core/merchants.mjs`). Plain kraft bags, no labels, no text, no brands, no people.
480 × 480 WebP (51 files), at most 60 KB each, served from Mandat's own origin so the MCP Apps cards' CSP lists that one
origin only. Alt texts live in `src/core/media.mjs`. Same MIT license as the rest of the repository.

## Design system

`simulator/design-system/` is the author's own design system (Apple Human Interface Guidelines as reference),
copied here so the repository stands alone.
