# maslovart.com

Temporary preview of Guennadi Maslov's new website, showing the look and feel.
It is plain HTML with no build step, so Netlify can publish this folder as-is.

- `index.html` is the landing page, with a picture tile for each of the four previews.
- Version 1 (the original, kept unchanged as a fallback):
  `site.html` is the site itself, `desktop.html` shows it full-width,
  `mobile.html` shows it inside a phone-sized frame.
- Version 2 (where Guennadi's changes go): `site-v2.html`, `desktop-v2.html`, `mobile-v2.html`.
- `images/previews/` holds the screenshots used on the landing page tiles.
  Retake the `-v2` ones when Version 2 changes.

These files came from `MaslovArt_WebsiteSpecs.afpub.zip`.

## Photo sets

`images/<set>/NN.jpg` holds Guennadi's photos, copied from the current maslovart.com
in the same sets and order. `images/<set>/thumbs/` has smaller copies for the grids.
The list of sets (names, intro text, photo counts) is the `SETS` list near the bottom of `site.html`.
