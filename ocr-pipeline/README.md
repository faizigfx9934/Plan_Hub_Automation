# OCR Pipeline — Quick Start

## Folder Structure

```
ocr_pipeline/
├── input/          ← Drop your PNG files here
├── output/         ← CSV results appear here (timestamped)
├── logs/           ← One log file per run
├── venv/           ← Auto-created by SETUP.bat (don't touch)
├── SETUP.bat       ← Run ONCE on each new machine
├── RUN.bat         ← Run every time to process images
├── ocr_pipeline.py ← Main script
└── requirements.txt
```

## First Time on Any Machine

1. Make sure **Python 3.8+** is installed (`python --version` in cmd)
2. Double-click **SETUP.bat** — wait for it to finish (~5-10 mins)
3. Done. Never run SETUP.bat again on this machine.

## Every Day Usage

1. Copy your screenshots into the **input/** folder
   or into a project folder inside **input/** (example: `input/My Project/*.png`)
2. Double-click **RUN.bat**
3. Find your CSV in the **output/** folder

## Output CSV Columns

| Column | Description |
|---|---|
| project_folder | Project subfolder name inside `input/` |
| file | Original filename |
| company_name | Company name detected from the screenshot card |
| location | Address/location line detected from the screenshot card |
| emails | All emails found |
| phones | All phone numbers found |
| websites | All URLs/websites found |
| states | US states detected |
| raw_text | Full OCR text |
| confidence_avg | OCR confidence (0–1, higher = better) |
| error | Any error for that image |

## Copying to a New Machine

Just zip the entire `ocr_pipeline/` folder **excluding the `venv/` folder**
(it's large and machine-specific). On the new machine, run SETUP.bat again.

## Tuning

Open `ocr_pipeline.py` and adjust at the top:
- `NUM_WORKERS = 2` → Set to number of CPU cores on target machine
- `MIN_CONFIDENCE = 0.6` → Lower to catch more text, raise for stricter quality
