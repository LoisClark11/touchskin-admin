# TouchSkin Admin

Admin dashboard for the **TouchSkin** skincare storefront — product catalog,
the storefront carousel, and the order log, all kept in sync in real time.

A deliberately plain static site: four files, **no build step, no npm, no
server**. It deploys for free on GitHub Pages and talks to the same Supabase
project the mobile app uses.

> The storefront itself lives in the companion repo **`integration_mobile`**
> (Flutter). The database schema, RLS policies, and storage rules are owned
> there — see its `supabase/schema.sql`.

---

## What's inside

| File | Role |
|---|---|
| `index.html` | UI shell: login, the three panels, edit modal, order detail |
| `app.js` | Everything dynamic — admin auth gate, CRUD, uploads, realtime streams, filters, XSS-safe rendering |
| `style.css` | TouchSkin blush & cream theme (palette lives in CSS variables at the top) |
| `supabase-config.js` | Supabase project URL + **publishable** key |
| `supabase/schema.sql` | Reference notes only — **never run it**. The authoritative schema is `supabase/schema.sql` in the storefront repo |

## Features

### Products
- Add / edit / delete products: name, price (PHP), stock, **category**, description.
- **Image upload** straight from your computer — validated and compressed in
  the browser before it touches Supabase Storage — or paste an image URL.
- The **category** dropdown drives the filter chips on the storefront app.
  The same six categories appear in three places and must stay in step: this
  file's `CATEGORIES` list, `lib/product_categories.dart` in the app, and the
  `products_category_check` constraint in the schema.
- Live table with thumbnails, category badges, and a low-stock highlight at
  5 units or fewer.
- Instant filter box (matches product names *and* categories).

### Featured slides
- Build the storefront carousel: wide banner picture, item picture, headline,
  subtitle, item name / price, and button label.
- Link a slide to a catalog product — its picture, name, and price can be
  inherited from the product row — or keep the slide standalone.
- Reorder with the arrows or a typed display order; activate / deactivate a
  slide without deleting it.
- Warns before you save a slide that would ship with no drawable picture.

### Orders
- Live order log with a count badge and a detail view (line items, customer).
- Filter chips **All / Completed / Cancelled** plus search by name, email, or
  order ID.
- The log is read-only: orders are written by the storefront's checkout, not
  from here.

### Under the hood
- **Realtime everywhere** — products, slides, and orders stream over Supabase
  Realtime. Save here and the app updates; order placed in the app and it
  appears here.
- **Hardened rendering** — every dynamic string goes through
  `escapeHtml` / `escapeAttribute`; the order `items` jsonb is treated as
  text, never trusted to be an array.
- **Timeouts and readable error messages** on every network call.

## Who can sign in

Supabase Auth will authenticate any valid account, so the gate lives in this
dashboard: every auth event is checked against `profiles.role = 'admin'`, and
anyone else is signed straight back out with a notice on the login screen
(`verifyAdminAccess` / `enterDashboard` in `app.js`).

Promote your account — run this in the Supabase SQL editor:

```sql
update public.profiles p
set role = 'admin'
from auth.users u
where p.id = u.id and u.email = 'admin@example.com';
```

> Customer logins are untouched. The storefront app uses the same Supabase
> Auth project; this admin gate applies only to this dashboard.

## Configuration

`supabase-config.js`:

```js
export const SUPABASE_URL = "https://<your-project>.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_..."; // older projects: eyJ...
```

- The publishable (anon) key is **designed to be public** — it ships inside
  the mobile app too. Row Level Security in Postgres is what protects the
  data, not the key.
- **Never** put the secret key (`sb_secret_...` / `service_role`) in this
  file. It bypasses RLS and must only ever live in server-side code.

## Deploy — GitHub Pages, $0

1. On github.com: **New repository** → e.g. `touchskin-admin` → **Public**.
2. From this folder:

   ```sh
   git init -b main          # skip if already a repo
   git add .
   git commit -m "TouchSkin admin dashboard"
   git remote add origin https://github.com/<you>/touchskin-admin.git
   git push -u origin main
   ```

3. Repo **Settings → Pages → Source: Deploy from a branch** → `main` /
   `(root)` → Save.
4. Live about a minute later at `https://<you>.github.io/touchskin-admin/`.

No git? [Netlify Drop](https://app.netlify.com/drop) works too — drag this
folder onto the page.

Every asset link in `index.html` is relative and the CDN imports are
absolute, so the site works from a subpath like `/touchskin-admin/` with no
changes.

## Run locally

`app.js` loads as an ES module, which browsers refuse over `file://` — serve
the folder instead:

```sh
python -m http.server 8080   # or: npx serve
```

Then open http://localhost:8080. There is nothing to install or build; any
editor will do.

## Requirements

A free tier covers everything:

- **Supabase project** with the schema and policies from the storefront
  repo's `supabase/schema.sql` — tables `products`, `featured_slides`,
  `orders`, `profiles` (RLS on) — and the `product-images` storage bucket.
- **GitHub account** for Pages (or any static host).

> ☁️ Supabase pauses free projects after about a week of inactivity. Opening
> the Supabase dashboard restores it in a minute; nothing is lost.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Signs in, then bounces back to the login screen | The account lacks `role = 'admin'` — run the promotion SQL above |
| Tables missing / "relation does not exist" | The schema hasn't been applied yet — run the storefront repo's `supabase/schema.sql` |
| Upload rejected | The `product-images` bucket is missing, or the file failed the type/size check |
| Writes time out, nothing loads | The Supabase project is paused — open the Supabase dashboard to wake it |
| New category doesn't show in the app | Categories live in three places (`CATEGORIES` here, `lib/product_categories.dart`, SQL check) — update all three |
| Slides warn "no picture" | The slide has no banner **and** its linked product has no image — upload one of the two |

## Related

- **`integration_mobile`** — the TouchSkin Flutter storefront: schema, RLS
  policies, and the app that displays these products, slides, and orders.
