# Brand

| File | Use |
|---|---|
| `logo.png` (1200×630) | Submission graphic, social card. Under 3MB as required. |
| `logo.svg` | Source. Edit this, re-render the PNG. |
| `mark.png` (512×512) | Square avatar, favicon source. |
| `mark.svg` | Source. |

## Why this mark

It is the product, not a decoration. A green equity line held above a hard red floor, with
the band between them filled — that band is the headroom, the only number that matters on a
trader's screen. The line ends by crossing the floor, because that crossing is the moment the
contract acts.

Palette matches the app exactly: `#08090b` ground, `#2ee6a8` equity, `#ff4d5e` floor,
`#e8eaef` / `#5f6879` text.

## Re-rendering

```bash
google-chrome --headless=new --disable-gpu --window-size=1200,630 \
  --screenshot=brand/logo.png "file://$PWD/brand/logo.html"
```

Any SVG rasteriser works; Chrome is used because it is already a dependency of
`scripts/smoke-web.mjs`.
