# PlanHub Extractor — Build & Deploy Guide

## What's in this folder

- `planhub_extractor.py` — the script
- `planhub_extractor.spec` — PyInstaller build config
- `BUILD_INSTRUCTIONS.md` — this file
- `requirements.txt` — Python dependencies

---

## Option A: Build the .exe (do this ONCE on your machine)

This produces a single `PlanHubExtractor.exe` that runs on any Windows machine
with **no Python and no Tesseract installation needed**. Perfect for distributing
to 30 laptops.

### Prerequisites on your build machine:

1. **Install Tesseract for Windows:**
   https://github.com/UB-Mannheim/tesseract/wiki
   - Use default install path: `C:\Program Files\Tesseract-OCR\`
   - Only English language pack is needed

2. **Install Python 3.10+ and the dependencies:**
   ```
   pip install pyinstaller pytesseract pillow openpyxl tqdm
   ```

### Build:

Open CMD in this folder and run:

```
pyinstaller planhub_extractor.spec --clean
```

Takes ~1-2 minutes. Your .exe will be at:

```
dist\PlanHubExtractor.exe
```

Size: ~30-50 MB (Tesseract is bundled inside).

### Distribute:

Just copy `PlanHubExtractor.exe` to each of the 30 laptops. That's it.
No installers, no Python, no dependencies.

---

## Option B: Run from Python (for development/testing)

```
pip install -r requirements.txt
python planhub_extractor.py
```

Requires Tesseract installed separately:
https://github.com/UB-Mannheim/tesseract/wiki

---

## How to use (end users)

1. Double-click `PlanHubExtractor.exe`
2. A console window opens.
3. Paste the full path to the folder containing PlanHub screenshots.
4. Press Enter twice.
5. Done — `planhub_data.xlsx` is saved in the same folder.

Processed screenshots move to a `done/` subfolder automatically.
If interrupted (Ctrl+C, power-off, crash), just re-run — it resumes.

---

## Fields extracted

| Field | Source |
|---|---|
| Company Name | Header title |
| Email | General Information section |
| Phone | General Information section |
| Website | General Information section |
| Address / City / State | Header address line |

Accuracy target: **~95%+** on clean 1920×1080 PlanHub screenshots.

---

## Troubleshooting

**"Tesseract not found"** (only when running from Python source, not the .exe):
- Install from: https://github.com/UB-Mannheim/tesseract/wiki
- Use the default path (`C:\Program Files\Tesseract-OCR\`)

**Fields empty for some screenshots:**
- PlanHub sometimes has no email/phone/website listed on a profile — that's
  a blank field on the original page, not a parsing bug.
- If a screenshot is cut off or low-resolution, OCR quality degrades.
  Ensure screenshots are at least 1440px wide.

**Wanting to add more fields later:**
- Edit `planhub_extractor.py` → `FIELDS`, `COLUMNS`, `HEADER_LABELS`
- Add a parser function modeled on `parse_general_info`
- Rebuild the .exe with `pyinstaller planhub_extractor.spec --clean`
