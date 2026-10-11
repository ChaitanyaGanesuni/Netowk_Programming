"""Record casparser 1.4.1 output for each fixture as the expected result."""
import json
import sys
from pathlib import Path

from casparser import read_cas_pdf

root = Path(sys.argv[1])
for pdf in sorted((root / "pdf").glob("*.pdf")):
    data = json.loads(read_cas_pdf(str(pdf), "ABCDE1234F", output="json"))
    data.pop("investor_info", None)  # personal block: not imported by the app
    (root / "expected").mkdir(exist_ok=True)
    (root / "expected" / f"{pdf.stem}.json").write_text(json.dumps(data, indent=1) + "\n")
    print(pdf.name, "pages ok", "warnings:", data.get("parse_warnings"))
