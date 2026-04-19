# PlanHub Scraper

Automated scraper that logs into PlanHub, walks every project in a rolling date window, and captures every subcontractor company page as a high-quality PNG for downstream OCR.

Designed to run unattended on 30+ Windows laptops, one per US state, each with its own PlanHub account.

---

## What's in this repo

| File / folder | Purpose |
|---|---|
| `scraper.js` | Main scraper. Playwright-driven, runs up to 8.5 hours per launch. |
| `selectors.js` | Centralized DOM selectors. Update here when PlanHub changes markup. |
| `logger.js` | Small console logger with step / ok / fail / info levels. |
| `run-scraper.bat` | Double-click entry point for operators. |
| `planhub_extractor.py` | Python OCR pass that reads the PNGs and outputs `planhub_data.xlsx`. |
| `planhub_extractor.spec` | PyInstaller config to bundle the OCR tool into a single `.exe`. |
| `run_OCR.bat` | Double-click entry point for the OCR step. |
| `BUILD_INSTRUCTIONS.md` | How to build `PlanHubExtractor.exe` from `planhub_extractor.py`. |
| `requirements.txt` | Python deps for the OCR tool. |
| `package.json` | Node deps for the scraper. |
| `.env.example` | Template for per-laptop credentials. |

## Ignored (generated at runtime — not in git)

| Path | Purpose |
|---|---|
| `.env` | Per-laptop credentials. Copy from `.env.example`. |
| `session.json` | Saved browser session so we don't log in every run. |
| `runs/YYYY-MM-DD/` | One folder per day with `data.json`, `data.csv`, `new-companies.csv`. |
| `screenshots/<Project Name> (MM-DD-YYYY)/` | One folder per project with a PNG per subcontractor. |
| `node_modules/` | Node dependencies. |

---

## Setup on a new laptop

### 1. Prerequisites
- **Node.js 20+** — https://nodejs.org
- **Git** — https://git-scm.com
- (OCR step only) **Python 3.10+** and Tesseract — see `BUILD_INSTRUCTIONS.md`

### 2. Clone and install
```
git clone <repo-url> planhub-scraper
cd planhub-scraper
npm install
npx playwright install chromium
```

### 3. Configure this laptop
```
copy .env.example .env
notepad .env
```
Fill in the PlanHub email/password for this laptop's state, plus `LAPTOP_ID` and `STATE`.

### 4. Run
Double-click `run-scraper.bat` (or `node scraper.js` in a terminal).

The first run opens a browser, logs in, and saves `session.json`. Subsequent runs reuse the session.

---

## How the scraper works

1. Logs in (or reuses `session.json`).
2. Sets a 7-day date filter (today → today+7).
3. Walks every project on every page.
4. For each project:
   - Reads the project name and bid-due date.
   - Creates `screenshots/<Project Name> (MM-DD-YYYY)/`.
   - Opens the Subcontractors tab, paginates through every sub-page.
   - For each company: opens detail page, takes a full-page PNG, closes.
   - Skips companies already scraped (dedup key = `project + company`).
5. When the date window is exhausted, shifts forward by 1 day and repeats.
6. Stops gracefully at the 8.5-hour mark or when you hit Ctrl+C.

Output:
- `runs/<date>/data.json` — authoritative record of everything scraped.
- `runs/<date>/data.csv` — flat CSV of the same.
- `runs/<date>/new-companies.csv` — only companies new this run.
- `screenshots/<project folder>/*.png` — raw captures for OCR.

---

## OCR step

After scraping, run `PlanHubExtractor.exe` (or `python planhub_extractor.py`).
Point it at the `screenshots/` folder; it outputs `planhub_data.xlsx`. See `BUILD_INSTRUCTIONS.md` for packaging details.

---

## Fleet deployment notes

- **One PlanHub account per laptop**, scoped to one US state. Accounts must not overlap states.
- **Dedup is local** — each laptop only sees its own state's projects, so no cross-laptop coordination is needed.
- **Updates propagate via `git pull`** — the launcher bat pulls the latest code before every run.
- **Emergency remote access** — install AnyDesk unattended on each laptop.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `locator.click: Timeout 30000ms exceeded` on the date picker | PlanHub changed the calendar DOM. Update `setDateFilter` in `scraper.js` or the aria-label format in `clickCalendarDay`. |
| Session fails and login prompt appears every run | Delete `session.json`. |
| Folder name too long error on Windows | Shorten the `.slice(0, 120)` cap in `scrapeProject`. |
| `Playwright executable doesn't exist` | Run `npx playwright install chromium`. |
| Empty `runs/<date>/data.json` | Check `.env` credentials and that PlanHub login works manually. |

---

## Repo hygiene

- Never commit `.env` or `session.json` (already gitignored).
- Keep `scraper.js` and `selectors.js` as the source of truth — no `scraper - Copy.js` backups.
- Use branches for experimental changes; main should always be deployable.
