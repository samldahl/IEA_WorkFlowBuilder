#!/usr/bin/env python3
"""Flatten the sheets Amy sends into CSV so the Node importer can read them.

The app has no xlsx dependency and does not need one: these workbooks arrive by
email a few times a year, and a conversion step we can read is better than a
parser we have to keep. Run this whenever a refreshed workbook lands, then run
`node crm-import-amy.js`.

    python tools/xlsx-to-csv.py [--src FromAmy] [--out FromAmy/converted]

Every sheet of every .xlsx in the source folder is written to
<out>/<workbook stem>__<sheet name>.csv. Header rows are taken verbatim; the
importer matches on them by name, so a renamed column shows up as an empty
field rather than silently landing in the wrong one.
"""

import argparse
import csv
import re
import sys
from pathlib import Path

try:
    import openpyxl
except ImportError:
    sys.exit("openpyxl is required: python -m pip install openpyxl")


def slug(text):
    return re.sub(r"[^A-Za-z0-9]+", "-", str(text)).strip("-")


def cell(value):
    if value is None:
        return ""
    # Dates arrive as datetimes; ISO keeps them unambiguous across the handoff.
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value).replace("\r\n", "\n").strip()


def convert(path, out_dir):
    written = []
    book = openpyxl.load_workbook(path, data_only=True, read_only=True)
    for sheet in book.worksheets:
        rows = [[cell(c) for c in row] for row in sheet.iter_rows(values_only=True)]
        # Drop fully blank rows; these sheets are full of spacer rows.
        rows = [r for r in rows if any(v for v in r)]
        if not rows:
            continue
        target = out_dir / f"{slug(path.stem)}__{slug(sheet.title)}.csv"
        with target.open("w", newline="", encoding="utf-8") as fh:
            csv.writer(fh).writerows(rows)
        written.append((target, len(rows) - 1))
    book.close()
    return written


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--src", default="FromAmy", help="folder holding the workbooks")
    ap.add_argument("--out", default=None, help="output folder (default <src>/converted)")
    args = ap.parse_args()

    src = Path(args.src)
    if not src.is_dir():
        sys.exit(f"No such folder: {src}")
    out_dir = Path(args.out) if args.out else src / "converted"
    out_dir.mkdir(parents=True, exist_ok=True)

    books = sorted(p for p in src.glob("*.xlsx") if not p.name.startswith("~$"))
    if not books:
        sys.exit(f"No .xlsx files in {src}")

    for book in books:
        for target, count in convert(book, out_dir):
            print(f"{target}  ({count} rows)")


if __name__ == "__main__":
    main()
