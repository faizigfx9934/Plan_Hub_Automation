# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec to build a standalone Windows .exe.

This assumes you have Tesseract installed on your build machine at:
    C:\\Program Files\\Tesseract-OCR\\

The spec copies tesseract.exe and the English language data into a
`tesseract/` folder inside the bundled executable, so it runs standalone
without any installation on target machines.

BUILD COMMAND (run on a Windows machine):
    pyinstaller planhub_extractor.spec --clean

The resulting .exe will be at:  dist/PlanHubExtractor.exe
Just copy that single .exe to all 30 laptops. Done.
"""

from pathlib import Path

block_cipher = None

# Tesseract install location on the build machine
TESSERACT_DIR = Path(r"C:\Program Files\Tesseract-OCR")

# Files to bundle (Tesseract binary + English language data)
datas = []

if (TESSERACT_DIR / "tesseract.exe").exists():
    datas.append((str(TESSERACT_DIR / "tesseract.exe"), "tesseract"))
    # Bundle the entire tessdata folder (contains eng.traineddata)
    tessdata = TESSERACT_DIR / "tessdata"
    if tessdata.exists():
        # Essential files only — full tessdata is ~1GB, we only need English
        for f in ["eng.traineddata", "osd.traineddata"]:
            fp = tessdata / f
            if fp.exists():
                datas.append((str(fp), "tesseract/tessdata"))
    # Tesseract also needs these DLLs on Windows
    for dll in ["libtesseract-5.dll", "libleptonica-6.dll"]:
        dll_path = TESSERACT_DIR / dll
        if dll_path.exists():
            datas.append((str(dll_path), "tesseract"))

a = Analysis(
    ['planhub_extractor.py'],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Trim unused heavy libraries
        'numpy', 'matplotlib', 'scipy', 'pandas',
        'tkinter', 'test', 'unittest', 'pydoc',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='PlanHubExtractor',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,        # UPX compression — reduces .exe size ~40%
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,    # Keep console — users paste folder path
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    # icon='icon.ico',  # Optional: add a custom icon
)
