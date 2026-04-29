import os
import re
import csv
import sys
import time
import logging
import threading
import shutil
from pathlib import Path
from datetime import datetime
from concurrent.futures import ProcessPoolExecutor, as_completed

import gspread
import requests
from google.oauth2.service_account import Credentials
from tqdm import tqdm

import config

# Logging
log_path = Path("logs") / f"run_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(log_path, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger(__name__)

# Config
ROOT_DIR = Path(__file__).resolve().parent
INPUT_DIR = ROOT_DIR / "input"
OUTPUT_DIR = ROOT_DIR / "output"
DONE_DIR = ROOT_DIR / "done"
SOURCE_ROOT = Path(getattr(config, "SCREENSHOTS_ROOT", str(INPUT_DIR)))
NUM_WORKERS = config.NUM_WORKERS
MIN_CONFIDENCE = config.MIN_CONFIDENCE
IMAGE_EXTENSIONS = {".png"}
SHEET_HEADER = [
    "Project Name",
    "Company Name",
    "email",
    "Phone",
    "Website",
    "location",
]
SHEET_WRITE_LOCK = threading.Lock()
WORKER_CV2 = None
WORKER_NP = None
WORKER_OCR = None

OUTPUT_DIR.mkdir(exist_ok=True)
DONE_DIR.mkdir(exist_ok=True)

# Field extraction
US_STATES = (
    "Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|"
    "Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|"
    "Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|"
    "Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|"
    "North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|"
    "South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|"
    "West Virginia|Wisconsin|Wyoming|"
    "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|"
    "MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|"
    "WA|WV|WI|WY"
)

IGNORED_HEADER_LINES = {
    "subcontractor",
    "premium",
    "view more",
    "trades",
}

IGNORED_COMPANY_SNIPPETS = (
    "itbs received last 30 days",
    "gc connections",
    "general information",
    "message this business",
    "overview",
    "team",
    "website",
    "regions covered",
)

ADDRESS_HINTS = (
    "ave", "avenue", "st", "street", "rd", "road", "dr", "drive", "blvd",
    "boulevard", "ln", "lane", "ct", "court", "way", "pkwy", "parkway",
    "cir", "circle", "pl", "place", "ter", "terrace", "hwy", "highway",
)


def get_sheet():
    scopes = [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive",
    ]
    credentials = Credentials.from_service_account_file(
        config.CREDENTIALS_FILE,
        scopes=scopes,
    )
    client = gspread.authorize(credentials)
    spreadsheet = client.open_by_key(config.SHEET_ID)
    sheet_title = current_sheet_tab_name()
    try:
        return spreadsheet.worksheet(sheet_title)
    except gspread.exceptions.WorksheetNotFound:
        log.info(f"Worksheet '{sheet_title}' not found; creating it.")
        worksheet = spreadsheet.add_worksheet(title=sheet_title, rows=1000, cols=20)
        return worksheet


def format_duration(seconds: float) -> str:
    total_seconds = int(seconds)
    minutes, secs = divmod(total_seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}h {minutes}m {secs:02d}s"
    return f"{minutes}m {secs:02d}s"


def current_sheet_tab_name() -> str:
    machine_name = re.sub(r"\s+", " ", config.MACHINE_NAME).strip() or "Laptop"
    # Hardcoded to machine name only (removed the date part so it stays in one tab)
    return f"{machine_name}"[:100]


def current_sheet_url() -> str:
    return f"https://docs.google.com/spreadsheets/d/{config.SHEET_ID}/edit"


def get_discord_webhook_urls() -> list[str]:
    webhook_urls = getattr(config, "DISCORD_WEBHOOK_URLS", None)
    if webhook_urls:
        return [
            url for url in webhook_urls
            if url and url != "YOUR_DISCORD_WEBHOOK_URL_HERE"
        ]

    webhook_url = getattr(config, "DISCORD_WEBHOOK_URL", "YOUR_DISCORD_WEBHOOK_URL_HERE")
    if webhook_url and webhook_url != "YOUR_DISCORD_WEBHOOK_URL_HERE":
        return [webhook_url]

    return []


def send_discord_notification(
    title: str,
    fields: list[tuple[str, str]],
    level: str = "info",
    summary: str | None = None,
):
    webhook_urls = get_discord_webhook_urls()
    if not webhook_urls:
        return

    colors = {
        "info": 3447003,
        "warning": 16776960,
        "error": 15158332,
        "success": 5763719,
    }
    embed_fields = [
        {"name": name, "value": value or "-", "inline": True}
        for name, value in fields if value is not None
    ]
    payload = {
        "username": "OCR Pipeline",
        "embeds": [
            {
                "title": title,
                "description": (summary or "")[:4000] or None,
                "color": colors.get(level, colors["info"]),
                "fields": embed_fields[:25],
                "footer": {"text": f"OCR Pipeline | {config.MACHINE_NAME}"},
                "timestamp": datetime.utcnow().isoformat() + "Z",
            }
        ]
    }

    for webhook_url in webhook_urls:
        try:
            response = requests.post(webhook_url, json=payload, timeout=15)
            response.raise_for_status()
        except Exception as exc:
            log.warning(f"Discord notification failed for {webhook_url}: {exc}")


def notify_started(root_dir: Path, project_count: int, sheet_title: str):
    send_discord_notification(
        "🚀 OCR Started",
        [
            ("🖥️ Machine", config.MACHINE_NAME),
            ("📁 Source Root", str(root_dir)),
            ("📦 Projects Queued", str(project_count)),
            ("📄 Sheet Tab", sheet_title),
        ],
        level="info",
        summary="A new OCR run has started.",
    )


def notify_paused(reason: str):
    send_discord_notification(
        "⏸️ OCR Paused",
        [
            ("🖥️ Machine", config.MACHINE_NAME),
            ("⚠️ Reason", reason),
        ],
        level="warning",
        summary="The pipeline is waiting for an issue to be fixed before it can continue.",
    )


def notify_project_finished(project_name: str, rows_added: int, elapsed: float, moved_to: Path):
    send_discord_notification(
        "✅ Project Finished",
        [
            ("📂 Project", project_name),
            ("📈 Rows Added", str(rows_added)),
            ("⏱️ Duration", format_duration(elapsed)),
            ("📦 Archived To", str(moved_to)),
        ],
        level="success",
        summary="One project folder was processed and moved out of the active queue.",
    )


def notify_finished(total_rows: int, total_errors: int, elapsed: float, output_csv: Path, log_file: Path):
    send_discord_notification(
        "🎉 OCR Finished",
        [
            ("📈 Rows Added", str(total_rows)),
            ("❌ Errors", str(total_errors)),
            ("⏱️ Duration", format_duration(elapsed)),
            ("🔗 Sheet", current_sheet_url()),
            ("📝 Log File", str(log_file)),
        ],
        level="success",
        summary="The full OCR run completed successfully.",
    )


def notify_crashed(error_message: str):
    send_discord_notification(
        "💥 OCR Crashed",
        [
            ("🖥️ Machine", config.MACHINE_NAME),
            ("🔥 Error", error_message[:1000]),
        ],
        level="error",
        summary="The OCR pipeline stopped unexpectedly.",
    )


def ensure_header(sheet):
    values = sheet.get_all_values()
    if not values:
        sheet.append_row(SHEET_HEADER)
        return

    current_header = values[0][:len(SHEET_HEADER)]
    if current_header != SHEET_HEADER:
        sheet.update("A1:F1", [SHEET_HEADER])


def append_rows_to_sheet(sheet, rows):
    if not rows:
        return

    for attempt in range(3):
        try:
            with SHEET_WRITE_LOCK:
                sheet.append_rows(rows, value_input_option="RAW")
            log.info(f"Appended {len(rows)} row(s) to sheet tab '{sheet.title}'")
            return
        except Exception as exc:
            wait_seconds = (attempt + 1) * 10
            if attempt == 2:
                raise
            log.warning(
                f"Google Sheets append failed ({exc}); retrying in {wait_seconds}s"
            )
            time.sleep(wait_seconds)


def normalise_company_name(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip(" -|,")
    text = re.sub(
        r"\b(?:planhub|projects|lead finder|takeoff \+ estimation|bid planner|my bids|directory|messages|my company|request a demo|upgrade|insights|premium|subcontractor|view more|gc connections)\b",
        "",
        text,
        flags=re.I,
    )
    text = re.sub(r"[:@]+$", "", text).strip(" -|,.")

    words = text.split()
    while len(words) >= 2 and re.fullmatch(r"[A-Z0-9]{1,6}", words[0]):
        if words[1].lower().startswith(words[0].lower()):
            words = words[1:]
            continue
        if len(words) >= 3:
            words = words[1:]
            continue
        break

    text = " ".join(words)
    return re.sub(r"\s+", " ", text).strip(" -|,.")


def cleanup_location(text: str) -> str:
    text = re.sub(r"^\W+", "", text).strip()
    text = re.sub(r"\bview more\b.*$", "", text, flags=re.I).strip(" -|,")
    text = re.sub(r"\bITBs Received Last 30 days:?.*$", "", text, flags=re.I).strip(" -|,")
    text = re.sub(r"\bGC Connections:?.*$", "", text, flags=re.I).strip(" -|,")
    pattern = re.compile(
        r"\d+[A-Za-z0-9 .,#/-]*\b(?:Ave|Avenue|St|Street|Rd|Road|Dr|Drive|Blvd|Boulevard|Ln|Lane|Ct|Court|Way|Pkwy|Parkway|Cir|Circle|Pl|Place|Ter|Terrace|Hwy|Highway)\b[^,]*,\s*[^,]+,\s*[A-Z]{2}\b",
        flags=re.I,
    )
    candidates = []
    for match in re.finditer(r"\d", text):
        address_match = pattern.match(text[match.start():])
        if address_match:
            candidates.append(address_match.group(0))
    if candidates:
        text = max(candidates, key=len)

    parts = text.split()
    if len(parts) >= 2 and re.fullmatch(r"\d{1,4}", parts[0]) and any(ch.isdigit() for ch in parts[1]):
        parts = parts[1:]
    text = " ".join(parts)
    text = re.sub(r"\b([NSEW])(\d)", r"\1 \2", text)
    text = re.sub(r"(?<=[a-z])(?=[A-Z][a-z])", " ", text)
    text = re.sub(r"\b([A-Z])([A-Z][a-z])", r"\1 \2", text)
    text = re.sub(r",\s*", ", ", text)
    return re.sub(r"\s+", " ", text)


def looks_like_location(text: str) -> bool:
    lower = text.lower()
    has_state = bool(re.search(rf"\b({US_STATES})\b", text))
    has_number = bool(re.search(r"\d", text))
    has_address_word = any(word in lower for word in ADDRESS_HINTS)
    has_city_state = bool(re.search(r",[ ]*[A-Z]{2}\b", text))
    return has_state and (has_number or has_address_word or has_city_state)


def is_noise_line(text: str) -> bool:
    lower = text.strip().lower()
    if not lower:
        return True
    if lower in IGNORED_HEADER_LINES:
        return True
    if lower.startswith("trades"):
        return True
    return False


def build_text_lines(ocr_items: list) -> list[dict]:
    rows = []
    ordered_items = sorted(
        ocr_items,
        key=lambda item: (
            min(point[1] for point in item[0]),
            min(point[0] for point in item[0]),
        ),
    )

    for box, (text, conf) in ordered_items:
        if conf < MIN_CONFIDENCE:
            continue

        top = min(point[1] for point in box)
        left = min(point[0] for point in box)
        right = max(point[0] for point in box)
        height = max(point[1] for point in box) - top
        clean_text = re.sub(r"\s+", " ", text).strip()
        if not clean_text:
            continue

        if rows and abs(rows[-1]["top"] - top) <= max(12, height * 0.6):
            rows[-1]["parts"].append((left, clean_text))
            rows[-1]["top"] = min(rows[-1]["top"], top)
            rows[-1]["left"] = min(rows[-1]["left"], left)
            rows[-1]["right"] = max(rows[-1]["right"], right)
            rows[-1]["height"] = max(rows[-1]["height"], height)
        else:
            rows.append({
                "top": top,
                "left": left,
                "right": right,
                "height": height,
                "parts": [(left, clean_text)],
            })

    lines = []
    for row in rows:
        parts = [part for _, part in sorted(row["parts"], key=lambda item: item[0])]
        line_text = " ".join(parts)
        line_text = re.sub(r"\s+", " ", line_text).strip()
        if line_text:
            lines.append({
                "text": line_text,
                "top": row["top"],
                "left": row["left"],
                "right": row["right"],
                "height": row["height"],
            })

    return lines


def company_score(line: dict, location_left: float | None = None) -> float:
    text = line["text"]
    words = re.findall(r"[A-Za-z0-9&.,'-]+", text)
    alpha_words = [word for word in words if re.search(r"[A-Za-z]", word)]
    score = len(alpha_words) * 3 + min(len(text), 40) / 10

    if location_left is not None:
        score -= abs(line["left"] - location_left) / 120
    if line["left"] < 350:
        score -= 6
    if re.fullmatch(r"[A-Z0-9]{1,5}", text):
        score -= 8
    if any(char.isdigit() for char in text):
        score -= 3
    if is_noise_line(text):
        score -= 20
    if any(snippet in text.lower() for snippet in IGNORED_COMPANY_SNIPPETS):
        score -= 30
    if ":" in text:
        score -= 12
    if len(text) > 55:
        score -= 15
    if 2 <= len(alpha_words) <= 8:
        score += 6
    if len(alpha_words) > 10:
        score -= 12
    if re.search(r"\b(llc|inc|inc\.|company|corp|corporation|ltd|limited)\b", text, flags=re.I):
        score += 12
    if line["top"] < 80:
        score -= 50
    if line["top"] > 260:
        score -= 20
    if 110 <= line["top"] <= 210:
        score += 10

    return score


def extract_company_and_location(lines: list[dict]) -> dict:
    company_name = ""
    location = ""
    location_left = None
    location_top = None

    for line in lines:
        if looks_like_location(line["text"]):
            location = cleanup_location(line["text"])
            location_left = line["left"]
            location_top = line["top"]
            break

    if location:
        candidates = []
        for line in lines:
            if location_top is not None and line["top"] >= location_top:
                break
            text = line["text"]
            if is_noise_line(text) or looks_like_location(text):
                continue
            if location_top is not None and line["top"] < max(80, location_top - 130):
                continue
            candidates.append((company_score(line, location_left), text))

        if candidates:
            company_name = normalise_company_name(max(candidates, key=lambda item: item[0])[1])

    if not company_name:
        candidates = []
        for line in lines:
            text = line["text"]
            if is_noise_line(text) or looks_like_location(text):
                continue
            candidates.append((company_score(line), text))
        if candidates:
            company_name = normalise_company_name(max(candidates, key=lambda item: item[0])[1])

    return {
        "company_name": company_name,
        "location": location,
    }


def titleize_filename_part(part: str) -> str:
    upper_tokens = {"llc", "inc", "corp", "co", "ltd", "usa"}
    words = []
    for word in part.split("_"):
        if not word:
            continue
        if word.lower() in upper_tokens:
            words.append(word.upper())
        else:
            words.append(word.capitalize())
    return " ".join(words)


def company_name_from_filename(image_path: Path) -> str:
    stem = re.sub(r"_\d{4}-\d{2}-\d{2}$", "", image_path.stem)
    parts = stem.split("__")
    suffix_tokens = {"llc", "inc", "corp", "co", "ltd", "company"}

    company_parts = []
    if len(parts) >= 3:
        company_parts.extend(parts[:-2])
        middle_words = parts[-2].split("_")
        if middle_words and middle_words[0].lower() in {"inc", "llc", "corp", "co", "ltd"}:
            company_parts.append(middle_words[0])
    elif len(parts) == 2:
        words = parts[0].split("_")
        suffix_index = max((idx for idx, word in enumerate(words) if word.lower() in suffix_tokens), default=-1)
        if suffix_index >= 0:
            company_parts.append("_".join(words[:suffix_index + 1]))
        else:
            company_parts.append(parts[0])
    else:
        company_parts.append(stem)

    company = ", ".join(titleize_filename_part(part) for part in company_parts if part)
    company = company.replace(", LLC", " LLC").replace(", INC", ", Inc").replace(", CORP", ", Corp")
    return company.strip(" ,")


def should_use_filename_company(company_name: str) -> bool:
    if not company_name or len(company_name) < 5:
        return True
    lower = company_name.lower()
    if any(snippet in lower for snippet in IGNORED_COMPANY_SNIPPETS):
        return True
    if any(noise in lower for noise in {"message this business", "overview", "trades", "premium"}):
        return True
    if "@" in company_name:
        return True
    if re.match(r"^[A-Z0-9]{2,}\s+[A-Z][a-z]", company_name):
        return True
    words = company_name.split()
    if len(words) >= 2 and words[0].lower().strip(".,") == words[1].lower().strip(".,"):
        return True
    return False


def city_from_location(location: str) -> str:
    parts = [part.strip() for part in location.split(",") if part.strip()]
    if len(parts) >= 2:
        return parts[-2]
    return ""


def strip_location_from_company(company_name: str, location: str) -> str:
    city = city_from_location(location)
    if not city:
        return company_name

    city_words = city.split()
    company_words = company_name.split()
    if len(company_words) >= len(city_words):
        tail = company_words[-len(city_words):]
        if [word.lower().strip(".,") for word in tail] == [
            word.lower().strip(".,") for word in city_words
        ]:
            company_name = " ".join(company_words[:-len(city_words)])

    return company_name.strip(" ,.-")


def extract_fields(text: str, lines: list[dict], image_path: Path) -> dict:
    emails = re.findall(r"[\w.+-]+@[\w-]+\.[\w.]+", text)
    phones = re.findall(
        r"(?:\+?1[\s\-.]?)?\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}", text
    )
    websites = re.findall(r"(?:https?://|www\.)[^\s,;\"'<>]+", text)
    states = re.findall(rf"\b({US_STATES})\b", text)
    structured = extract_company_and_location(lines)
    if should_use_filename_company(structured["company_name"]):
        structured["company_name"] = company_name_from_filename(image_path)
    structured["company_name"] = strip_location_from_company(
        structured["company_name"],
        structured["location"],
    )

    return {
        "company_name": structured["company_name"],
        "location": structured["location"],
        "emails": " | ".join(dict.fromkeys(emails)),
        "phones": " | ".join(dict.fromkeys(phones)),
        "websites": " | ".join(dict.fromkeys(websites)),
        "states": " | ".join(dict.fromkeys(states)),
    }


def list_project_dirs(root_dir: Path) -> list[Path]:
    return sorted(
        path for path in root_dir.iterdir()
        if path.is_dir() and path.name.lower() != "done"
    )


def list_project_images(project_dir: Path) -> list[Path]:
    candidates = sorted(
        path for path in project_dir.rglob("*")
        if path.is_file()
        and path.suffix.lower() in IMAGE_EXTENSIONS
        and not path.name.endswith("_tmp.png")
    )

    pending = []
    for path in candidates:
        relative_path = path.relative_to(project_dir)
        relative_parts = list(relative_path.parts)
        if relative_parts and relative_parts[0].lower() == "done":
            relative_parts = relative_parts[1:]
        normalized_relative = Path(*relative_parts) if relative_parts else Path(path.name)
        central_done_path = DONE_DIR / project_dir.name / normalized_relative
        if not central_done_path.exists():
            pending.append(path)

    return pending


def move_image_to_done(project_dir: Path, image_path: Path) -> Path:
    relative_path = image_path.relative_to(project_dir)
    relative_parts = list(relative_path.parts)
    if relative_parts and relative_parts[0].lower() == "done":
        relative_parts = relative_parts[1:]
    normalized_relative = Path(*relative_parts) if relative_parts else Path(image_path.name)

    target_parent = DONE_DIR / project_dir.name
    target_parent.mkdir(parents=True, exist_ok=True)

    target_path = target_parent / normalized_relative
    target_path.parent.mkdir(parents=True, exist_ok=True)

    if target_path.exists():
        suffix = datetime.now().strftime("%H%M%S")
        target_path = target_path.with_name(f"{target_path.stem}_{suffix}{target_path.suffix}")

    shutil.move(str(image_path), str(target_path))
    return target_path


def remove_empty_parent_dirs(start_dir: Path, stop_dir: Path):
    current = start_dir
    while current != stop_dir:
        try:
            current.rmdir()
        except OSError:
            break
        current = current.parent


def remove_project_tree_if_empty(project_dir: Path):
    if not project_dir.exists():
        return

    children = list(project_dir.iterdir())
    for child in children:
        if child.is_dir():
            remove_project_tree_if_empty(child)

    if not any(project_dir.iterdir()):
        project_dir.rmdir()


def row_to_sheet_values(timestamp: str, row: dict) -> list:
    return [
        row["project"],
        row["company_name"],
        row["emails"],
        row["phones"],
        row["websites"],
        row["location"],
    ]


def init_ocr_worker():
    global WORKER_CV2, WORKER_NP, WORKER_OCR

    import cv2
    import numpy as np
    from paddleocr import PaddleOCR

    WORKER_CV2 = cv2
    WORKER_NP = np
    WORKER_OCR = PaddleOCR(
        use_angle_cls=True,
        lang="en",
        show_log=False,
        use_gpu=False,
        det_db_score_mode="slow",
    )


def process_image(task: tuple[str, str]) -> dict:
    """
    Runs in a child process using a worker-local OCR engine that is
    initialised once and reused across many images.
    """
    global WORKER_CV2, WORKER_NP, WORKER_OCR

    image_path, project_name = task
    image_path = Path(image_path)

    result_row = {
        "project": project_name,
        "file": image_path.name,
        "company_name": "",
        "location": "",
        "emails": "",
        "phones": "",
        "websites": "",
        "states": "",
        "raw_text": "",
        "confidence_avg": "",
        "error": "",
    }

    try:
        if WORKER_CV2 is None or WORKER_NP is None or WORKER_OCR is None:
            init_ocr_worker()

        # Pre-processing (tuned for screenshots / digital text)
        img = WORKER_CV2.imread(str(image_path))
        if img is None:
            raise ValueError("Could not read image (corrupt or wrong format)")

        # Upscale small images - PaddleOCR likes >= 32px tall characters
        h, w = img.shape[:2]
        if h < 800:
            scale = 800 / h
            img = WORKER_CV2.resize(
                img,
                (int(w * scale), 800),
                interpolation=WORKER_CV2.INTER_CUBIC,
            )

        gray = WORKER_CV2.cvtColor(img, WORKER_CV2.COLOR_BGR2GRAY)

        # Mild sharpening
        kernel = WORKER_NP.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]])
        gray = WORKER_CV2.filter2D(gray, -1, kernel)

        # Save preprocessed temp file
        tmp = str(image_path) + "_tmp.png"
        WORKER_CV2.imwrite(tmp, gray)

        # OCR
        raw = WORKER_OCR.ocr(tmp, cls=True)

        if not raw or not raw[0]:
            return result_row  # Blank image

        # Flatten tokens and rebuild positional lines
        tokens, confs = [], []
        for line in raw[0]:
            text_val, conf = line[1]
            if conf >= MIN_CONFIDENCE:
                tokens.append(text_val)
                confs.append(conf)

        lines = build_text_lines(raw[0])

        full_text = " ".join(tokens)
        avg_conf = round(sum(confs) / len(confs), 3) if confs else 0

        fields = extract_fields(full_text, lines, image_path)
        result_row.update(fields)
        result_row["raw_text"] = full_text
        result_row["confidence_avg"] = avg_conf

    except Exception as exc:
        result_row["error"] = str(exc)
    finally:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass

    return result_row


def main():
    if config.SHEET_ID == "YOUR_GOOGLE_SHEET_ID_HERE":
        log.error("Please set SHEET_ID in config.py before running.")
        notify_paused("SHEET_ID is still a placeholder.")
        sys.exit(1)

    source_root = Path(sys.argv[1]) if len(sys.argv) >= 2 else SOURCE_ROOT
    if not source_root.exists() or not source_root.is_dir():
        log.error(f"Screenshots root not found: {source_root}")
        notify_paused(f"Screenshots root not found: {source_root}")
        sys.exit(1)

    project_dirs = list_project_dirs(source_root)
    if not project_dirs:
        log.error(f"No project folders found inside: {source_root}")
        notify_paused(f"No project folders found inside {source_root}")
        sys.exit(1)

    sheet = get_sheet()
    sheet_title = sheet.title
    ensure_header(sheet)
    log.info(f"Using Google Sheet tab: {sheet_title}")

    notify_started(source_root, len(project_dirs), sheet_title)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_csv = OUTPUT_DIR / f"results_{timestamp}.csv"
    start = time.time()
    total_done = 0
    total_errors = 0

    with open(output_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=SHEET_HEADER)
        writer.writeheader()

        for project_dir in project_dirs:
            project_name = project_dir.name
            project_images = list_project_images(project_dir)
            if not project_images:
                log.info(f"[{project_name}] Starting - 0 images")
                log.info(f"[{project_name}] Done - 0/0 in 0m00s")
                remove_project_tree_if_empty(project_dir)
                continue

            project_start = time.time()
            project_done = 0
            log.info(f"[{project_name}] Starting - {len(project_images)} images")

            with ProcessPoolExecutor(
                max_workers=NUM_WORKERS,
                initializer=init_ocr_worker,
            ) as pool:
                futures = {
                    pool.submit(process_image, (str(image_path), project_name)): image_path
                    for image_path in project_images
                }

                with tqdm(
                    total=len(project_images),
                    unit="img",
                    colour="green",
                    desc=f"{project_name}",
                ) as pbar:
                    for future in as_completed(futures):
                        source_image_path = futures[future]
                        row = future.result()
                        csv_row = {
                            "Project Name": row["project"],
                            "Company Name": row["company_name"],
                            "email": row["emails"],
                            "Phone": row["phones"],
                            "Website": row["websites"],
                            "location": row["location"],
                        }
                        writer.writerow(csv_row)
                        f.flush()
                        append_rows_to_sheet(sheet, [row_to_sheet_values("", row)])
                        archived_image = move_image_to_done(project_dir, source_image_path)
                        if archived_image != source_image_path:
                            remove_empty_parent_dirs(source_image_path.parent, project_dir)
                        log.info(f"[{project_name}] Archived screenshot -> {archived_image}")
                        total_done += 1
                        project_done += 1
                        if row["error"]:
                            total_errors += 1
                        pbar.update(1)

            project_elapsed = time.time() - project_start
            log.info(
                f"[{project_name}] Done - {project_done}/{len(project_images)} "
                f"in {int(project_elapsed // 60)}m{int(project_elapsed % 60):02d}s"
            )
            remove_project_tree_if_empty(project_dir)
            notify_project_finished(project_name, project_done, project_elapsed, DONE_DIR / project_name)

    elapsed = time.time() - start
    log.info(
        f"Finished {total_done} images in {elapsed:.0f}s with {total_errors} errors"
    )
    log.info(f"Results -> {output_csv}")
    log.info(f"Log     -> {log_path}")
    notify_finished(total_done, total_errors, elapsed, output_csv, log_path)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        notify_crashed(str(exc))
        raise
