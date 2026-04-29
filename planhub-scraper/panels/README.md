# PlanHub Control Panel

Single static-site panel. Log in with the **owner password** → read-only business view. Log in with the **admin password** → full fleet management view (pause fleet, resolve quarantine entries, inspect errors).

No build step — it's plain HTML + CSS + a single ES module that loads React from a CDN.

---

## One-time setup: set the two panel passwords on the backend

From `backend/` folder:

```bash
npx wrangler secret put OWNER_PASSWORD
# type a simple password for the owner (e.g. "Pinnacle2026!")

npx wrangler secret put ADMIN_PASSWORD
# type a stronger password for you (e.g. a 20-char random string)

npx wrangler deploy     # redeploy so the Worker picks them up
```

---

## Deploy the panel to Cloudflare Pages

### One-time

From the repo root:

```bash
# Install wrangler globally (only needed on your dev machine)
npm install -g wrangler

# Deploy the panels/ folder as a Cloudflare Pages project
npx wrangler pages project create planhub-panel --production-branch main

# First deploy
npx wrangler pages deploy panels --project-name planhub-panel
```

Wrangler prints a URL like `https://planhub-panel.pages.dev`. That's the panel.

### Every time you edit `panels/app.js` or `panels/styles.css`

```bash
npx wrangler pages deploy panels --project-name planhub-panel
```

Takes ~10 seconds.

---

## How to use

- **Owner**: visit the panel URL, enter the owner password. Sees stats (companies today/week/all-time), per-state breakdown, laptop status. Read-only.
- **You (admin)**: same URL, enter the admin password. Sees everything plus: pause-fleet toggle, open-failures list with full stack traces, mark-resolved buttons, live config.

Sign out via the button in the top-right.

---

## Changing the API URL

If you ever move the backend to a custom domain, edit `panels/index.html`:

```html
<script>
  window.PLANHUB_API = "https://your-new-api-domain.com";
</script>
```

…and redeploy the panel.
