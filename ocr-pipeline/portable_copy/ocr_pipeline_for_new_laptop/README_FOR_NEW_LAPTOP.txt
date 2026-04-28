OCR Pipeline - New Laptop Setup

What to copy
- Copy this whole folder to the new laptop.
- This package already includes the project files and config.

Important
- Do not reuse the old virtual environment.
- Run SETUP.bat on the new laptop one time.

Steps on the new laptop
1. Extract the zip anywhere you want.
2. Open the folder.
3. Double-click SETUP.bat
4. Wait for installation to finish.
5. Open config.py
6. Change MACHINE_NAME to a unique name for that laptop
   Example:
   MACHINE_NAME = "Laptop-02"
7. Leave these as they are unless you want to change them:
   - SHEET_ID
   - SHEET_TAB_NAME
   - credentials.json
   - Discord webhook settings
8. Double-click TEST_WEBHOOK.bat
9. Confirm the Discord test message appears.
10. Put screenshots in this format:

C:\planhub-scraper\screenshots\
  ProjectAlpha\
    img001.png
    img002.png
    done\

11. Double-click RUN.bat

How it behaves
- The tool scans every project folder inside the screenshots root.
- Each processed screenshot is moved immediately into this OCR package's done\ProjectName\ folder.
- If a run is interrupted, rerunning only processes screenshots still left in the source project folder.
- Finished source project folders are removed only when they become empty.
- If internet fails or the laptop shuts down, rerun the tool and it continues from the remaining screenshots.
- Logs are written to logs/
- CSV backups are written to output/

Portable copy for another laptop
- Change SCREENSHOTS_ROOT in config.py to "input" if you want this package to use its own local input\ folder.
- Run COPY_FOR_NEW_LAPTOP.bat to create a portable folder with the scripts plus input\ and output\ ready to paste on another laptop.

Recommended unique names
- Laptop-01
- Laptop-02
- Office-PC
- Workstation-A

Files you should keep
- ocr_pipeline.py
- config.py
- credentials.json
- requirements.txt
- SETUP.bat
- RUN.bat
- RESET_TOOL.bat
- TEST_WEBHOOK.bat
- test_webhook.py

If something fails
- Run TEST_WEBHOOK.bat first
- Check config.py
- Check that the Google Sheet is still shared with the service account email in credentials.json
- Check that Python is installed on the new laptop
