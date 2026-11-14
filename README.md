# maslovart.com

Temporary preview of Guennadi Maslov's new website, showing the look and feel.
It is plain HTML with no build step, so Netlify can publish this folder as-is.

- `index.html` is the landing page. It links only to Version 3 (desktop and mobile); the Version 1 and 2 files are kept as a fallback but no longer linked.
- Version 1 (the original, kept unchanged as a fallback):
  `site.html` is the site itself, `desktop.html` shows it full-width,
  `mobile.html` shows it inside a phone-sized frame.
- Version 2 (where Guennadi's changes go): `site-v2.html`, `desktop-v2.html`, `mobile-v2.html`.
- Version 3 (Version 2 plus a 25% gray background behind the content): `site-v3.html`, `desktop-v3.html`, `mobile-v3.html`.
  Changes to Version 2 should usually be copied into Version 3 too.
- `images/previews/` holds the screenshots used on the landing page tiles.
  All four tiles show the homepage, so the versions look alike on the landing page.

These files came from `MaslovArt_WebsiteSpecs.afpub.zip`.

## Photo sets

`images/<set>/NN.jpg` holds Guennadi's photos, copied from the current maslovart.com
in the same sets and order. `images/<set>/thumbs/` has smaller copies for the grids.
The list of sets (names, intro text, photo counts) is the `SETS` list near the bottom of `site.html`.

## Admin page

After signing in, the admin opens on a home screen with one button per area (New Prints, Vintage Prints, The Artist, Contact, Messages, Mailing list, Users, Earlier versions). "Admin home" goes back to it. New Prints has three tabs inside (Sizes & prices, Series text, Photos). Each vintage print has exactly one size and price.

Users: the **Users** tab lists everyone who can sign in (Supabase table `admins`: email, first/last name, phone, role).
Two roles: **Admin** (everything, including adding/removing team members) and **Site Manager** (everything except the team).
Adding someone runs the Supabase edge function `team`, which sends them an invitation email to choose a password. Everyone can change their own password there; Admins can also set anyone's password.


`admin.html` is a private page where Alan and Guennadi sign in and change the site without editing code:
print sizes and prices, series names and introductions, photo titles, which photos are "not for sale",
the text on The Artist page, and the contact phone and email. It also keeps every earlier version, so a
mistake can be undone.

How it works: the changes are saved in Supabase (project "MaslovArt.com Website"), and Version 3
(`site-v3.html`) lays them over the values written into the page when it loads. If Supabase can't be
reached, the site simply shows the built-in values. Only emails listed in the `admins` table can save.

Photo uploads go to Guennadi's Cloudinary account (cloud `dniry2qgz`, folder `maslovart/`). The admin page asks
the Supabase helper `cloudinary-sign` for permission first; it only says yes to people on the admins list.

## Backups

- **Database (Supabase):** the Pro plan takes an automatic backup of the whole database every day (kept 7 days). It covers content, messages, mailing list and users. Restore from Supabase dashboard > Database > Backups.
- **Every save in the admin** is also kept in "Earlier versions" (table `site_content_history`).
- **Daily off-site copy:** `.github/workflows/daily-backup.yml` runs every night. It saves the site content as JSON plus every Cloudinary photo it uses to the `backups` branch of this repo (last 90 days of content). Run it by hand from the GitHub Actions tab.
- Photos stored in `images/` are part of this repo, so GitHub keeps every version of them.
