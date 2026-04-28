from datetime import datetime

import requests

import config


def main():
    payload = {
        "username": "OCR Pipeline",
        "embeds": [
            {
                "title": "\U0001f389 OCR Finished",
                "description": "The full OCR run completed successfully.",
                "color": 5763719,
                "fields": [
                    {"name": "\U0001f4c8 Rows Added", "value": "128", "inline": True},
                    {"name": "\u274c Errors", "value": "0", "inline": True},
                    {"name": "\u23f1\ufe0f Duration", "value": "4m 32s", "inline": True},
                    {"name": "\U0001f517 Sheet", "value": f"https://docs.google.com/spreadsheets/d/{config.SHEET_ID}/edit", "inline": False},
                    {"name": "\U0001f4dd Log File", "value": r"logs\\run_20260423_214651.log", "inline": False},
                ],
                "footer": {"text": f"OCR Pipeline | {config.MACHINE_NAME}"},
                "timestamp": datetime.utcnow().isoformat() + "Z",
            }
        ],
    }

    webhook_urls = getattr(config, "DISCORD_WEBHOOK_URLS", None)
    if webhook_urls:
        webhook_urls = [
            url for url in webhook_urls
            if url and url != "YOUR_DISCORD_WEBHOOK_URL_HERE"
        ]
    else:
        webhook_url = getattr(config, "DISCORD_WEBHOOK_URL", "YOUR_DISCORD_WEBHOOK_URL_HERE")
        webhook_urls = [webhook_url] if webhook_url and webhook_url != "YOUR_DISCORD_WEBHOOK_URL_HERE" else []

    if not webhook_urls:
        raise SystemExit("Discord webhook URL is not set in config.py")

    sent = 0
    for webhook_url in webhook_urls:
        response = requests.post(webhook_url, json=payload, timeout=15)
        response.raise_for_status()
        sent += 1

    print(f"Webhook test sent successfully to {sent} webhook(s).")


if __name__ == "__main__":
    main()
