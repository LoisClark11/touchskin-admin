# TouchSkin Admin (web)

The admin dashboard for the **TouchSkin** storefront: product catalog,
featured slides, order log.

Plain static site — four JS/HTML/CSS files, **no build step, no npm**. It was
split out of the storefront repo (`integration_mobile`) so it can be deployed
on its own, for free.

## Files

| File | Role |
|---|---|
| `index.html` | UI shell |
| `app.js` | All admin flows (auth gate, upload, save, slides, orders, XSS-safe order cells) |
| `style.css` | Theme (TouchSkin blush & cream palette, all in CSS variables at the top) |
| `supabase-config.js` | Project URL + **publishable** key — designed to be public; Row Level Security is the protection. Never put the secret key (`sb_secret_...`) here |
| `supabase/schema.sql` | **Notes only, never run.** The authoritative schema is `supabase/schema.sql` in the storefront repo |

## Deploy — GitHub Pages, $0

1. On github.com: **New repository** (e.g. `touchskin-admin`), Public, no
   README needed.
2. From this folder:

   ```
   git init -b main
   git add .
   git commit -m "TouchSkin admin dashboard"
   git remote add origin https://github.com/<you>/touchskin-admin.git
   git push -u origin main
   ```

3. Repo **Settings → Pages → Source: Deploy from a branch** → `main` /
   `(root)` → Save.
4. Live about a minute later at `https://<you>.github.io/touchskin-admin/`.

Alternative without git: [Netlify Drop](https://app.netlify.com/drop) — drag
this folder onto the page, done.

Because every asset link in `index.html` is relative and the CDN imports are
absolute, the site works from a subpath like this with no changes.

## Who can sign in

Supabase Auth accepts any valid account, but the dashboard verifies
`role = 'admin'` on every auth event and signs anyone else straight back out.
Promote accounts in the Supabase SQL editor (see section 5 of the storefront
repo's `supabase/schema.sql`):

```sql
update public.profiles p
set role = 'admin'
from auth.users u
where p.id = u.id and u.email = 'admin@example.com';
```
