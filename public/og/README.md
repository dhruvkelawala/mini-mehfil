# Social preview card

`mini-mehfil-card.jpg` is the 1200x630 image every shared link points at: the
home page, room invitations, and the Worker-rendered `/s/:id` player. It is a
crop of the production courtyard scene with the stacked wordmark and the app
tagline burned in, so a link with no other context still says what this is.

Three surfaces reference it and all three must keep pointing at the same file:

- `src/client/host/index.html` and `src/client/listener/index.html` (`og:image`)
- `share/wrangler.jsonc` (`SHARE_PREVIEW_IMAGE_URL`, read by `src/worker/index.ts`)

Only the host build copies `public/` into `dist/host`, so the file is served
from the Vercel origin at `https://minimehfil.wtf/og/mini-mehfil-card.jpg`. The
Worker links to that absolute URL rather than shipping its own copy.

## Regenerate

`card-overlay.svg` is the editable text layer. Both steps need ImageMagick and
`librsvg`, plus the macOS system fonts (Kohinoor Devanagari and Iowan Old
Style); neither tool is a repository dependency, because the card is a committed
artifact rather than a build output.

```bash
magick public/backgrounds/04-folk-modern-dusk.png \
  -gravity south -crop 1586x833+0+0 +repage \
  -resize 1200x630^ -gravity center -extent 1200x630 /tmp/og-base.png
rsvg-convert -w 1200 -h 630 public/og/card-overlay.svg -o /tmp/og-overlay.png
magick /tmp/og-base.png /tmp/og-overlay.png -composite -quality 88 -strip \
  public/og/mini-mehfil-card.jpg
```

Keep the result at exactly 1200x630 and under 300 KB. Readers downscale the
card to roughly 500 px wide in a feed, so check any copy change at that size
before committing it.
