# Static assets

Everything here is copied into `dist/host` by the host Vite build and served
from the Vercel origin. The listener build does not copy `public/`, so anything
the Worker-rendered room and share pages need must be linked absolutely at
`https://minimehfil.wtf/...` rather than relatively.

- `favicon.svg`, `favicon.ico`, `apple-touch-icon.png` — the tab and home
  screen mark, described below.
- `og/` — the social preview card. See `og/README.md`.
- `backgrounds/` — the courtyard scene used by the app and as the card's base.

## Tab icon

The mark is the Devanagari **म** under an amber eighth note, cream on the
courtyard night green. `favicon.svg` is the source of truth and the file to
edit; the other two are rasterized from it.

The glyph is a **path, not text**. A favicon renders on machines that may have
no Devanagari font installed, where a `font-family` reference would show tofu.
The outline came from Kohinoor Devanagari Bold, extracted once with `fontTools`
and pasted in; re-extract the same way if the letterform ever needs to change:

```python
from fontTools.ttLib import TTCollection
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

font = TTCollection('/System/Library/Fonts/Kohinoor.ttc').fonts[3]  # Bold
glyphs = font.getGlyphSet()
glyph = glyphs[font.getBestCmap()[ord('म')]]
pen = SVGPathPen(glyphs)
# Scale to 37px tall on a 64px tile with the baseline at y=59, and flip Y
# because font space points up while SVG points down.
glyph.draw(TransformPen(pen, (0.0551, 0, 0, -0.0551, 12.1, 59)))
print(pen.getCommands())
```

Rasterize the other two after any edit:

```bash
for size in 16 32 48; do
  rsvg-convert -w $size -h $size public/favicon.svg -o /tmp/icon-$size.png
done
magick /tmp/icon-16.png /tmp/icon-32.png /tmp/icon-48.png public/favicon.ico

# iOS applies its own rounded mask, so the touch icon is drawn square.
sed 's/ rx="14"//' public/favicon.svg > /tmp/icon-square.svg
rsvg-convert -w 180 -h 180 /tmp/icon-square.svg -o public/apple-touch-icon.png
```

Check the result at 16px before committing, zoomed with nearest-neighbour so
you see real pixels. Two things break there and nowhere else: the counter of
**म** fills in if the glyph is too light or too small, and the note merges into
the shirorekha if the gap between them drops below about 6px of the 64px tile.

```bash
rsvg-convert -w 16 -h 16 public/favicon.svg -o /tmp/icon-16.png
magick /tmp/icon-16.png -filter point -resize 1200% /tmp/icon-16-zoom.png
```
