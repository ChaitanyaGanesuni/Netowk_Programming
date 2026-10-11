"""Generate synthetic, password-protected CAS PDFs for differential testing.

All identities, folios and amounts are FAKE. The layouts follow what
casparser 1.4.1 (MIT, github.com/codereverser/casparser) parses, so the
same PDFs can be fed to casparser (the oracle) and to our TypeScript port
and the outputs compared field by field.

Run (from a venv with reportlab + pypdf + casparser==1.4.1):
    python generate_cas_fixtures.py <out_dir>
"""

import io
import json
import sys
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

PASSWORD = "ABCDE1234F"  # CAS PDFs are encrypted with the investor's PAN.
W, H = A4

# Transaction table column anchors (left x for text columns, right x for numbers).
X_DATE, X_DESC, X_AMT, X_UNITS, X_PRICE, X_BAL = 40, 100, 330, 400, 470, 545


def watermark(c, text):
    """Rotated issuer watermark down the left edge (excluded from layout)."""
    c.saveState()
    c.setFont("Helvetica", 6)
    c.translate(18, 120)
    c.rotate(90)
    c.drawString(0, 0, text)
    c.restoreState()


def txn_header(c, y):
    c.setFont("Helvetica-Bold", 8)
    c.drawString(X_DATE, y, "Date")
    c.drawString(X_DESC, y, "Transaction")
    c.drawRightString(X_AMT, y, "Amount")
    c.drawRightString(X_UNITS, y, "Units")
    c.drawRightString(X_PRICE, y, "Price")
    c.drawRightString(X_BAL, y, "Unit")
    c.drawRightString(X_AMT, y - 9, "(INR)")
    c.drawRightString(X_PRICE, y - 9, "(INR)")
    c.drawRightString(X_BAL, y - 9, "Balance")
    c.setFont("Helvetica", 8)
    return y - 24


def row(c, y, date, desc, amount="", units="", price="", balance="", wrap=""):
    c.drawString(X_DATE, y, date)
    c.drawString(X_DESC, y, desc)
    for x, value in ((X_AMT, amount), (X_UNITS, units), (X_PRICE, price), (X_BAL, balance)):
        if value:
            c.drawRightString(x, y, value)
    if wrap:  # long descriptions wrap onto a Transaction-column-only line
        y -= 9
        c.drawString(X_DESC, y, wrap)
    return y - 12


def rta_statement(path_stem, marker, rta, folios):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)

    def new_page(first=False):
        watermark(c, f"{marker}0000000000 Version:V3.4 Live-1017")
        c.setFont("Helvetica", 8)
        y = H - 40
        if first:
            c.setFont("Helvetica-Bold", 11)
            c.drawString(220, y, "Consolidated Account Statement")
            c.setFont("Helvetica", 8)
            c.drawString(230, y - 14, "01-Jan-2020 To 10-Oct-2026")
            y -= 34
            c.drawString(40, y, "Email Id: asha.verma@example.com")
            c.drawString(40, y - 11, "Asha Verma")
            c.drawString(40, y - 22, "12 Example Street")
            c.drawString(40, y - 33, "Pune 411001")
            c.drawString(40, y - 44, "Mobile: +919999999999")
            y -= 64
        return txn_header(c, y)

    def continuation_page():
        # A page that continues a table without repeating its header.
        watermark(c, f"{marker}0000000000 Version:V3.4 Live-1017")
        c.setFont("Helvetica", 8)
        return H - 60

    y = new_page(first=True)
    for folio in folios:
        if y < 260:
            c.showPage()
            y = new_page()
        c.setFont("Helvetica-Bold", 9)
        c.drawString(40, y, folio["amc"])
        c.setFont("Helvetica", 8)
        y -= 14
        c.drawString(40, y, f"Folio No: {folio['folio']}")
        c.drawString(200, y, "PAN: ABCDE1234F")
        c.drawString(300, y, "KYC: OK")
        c.drawString(360, y, "PAN: OK")
        y -= 11
        c.drawString(40, y, "Asha Verma")
        y -= 13
        for scheme in folio["schemes"]:
            if y < 200:
                c.showPage()
                y = new_page(first=False) if scheme.get("repeat_header", True) else continuation_page()
            c.drawString(40, y, f"{scheme['code']}-{scheme['name']} - ISIN: {scheme['isin']}(Advisor: {scheme['advisor']})")
            y -= 11
            c.drawString(40, y, f"Registrar : {rta}")
            y -= 11
            c.drawString(40, y, "Nominee 1: Ravi Verma")
            c.drawString(200, y, "Nominee 2:")
            c.drawString(300, y, "Nominee 3:")
            y -= 13
            c.drawString(X_DESC, y, f"Opening Unit Balance: {scheme['open']}")
            y -= 13
            for t in scheme["txns"]:
                if y < 80:
                    c.showPage()
                    y = new_page(first=False) if scheme.get("repeat_header", True) else continuation_page()
                y = row(c, y, t[0], t[1], *t[2:])
            c.setFont("Helvetica", 7)
            c.drawString(X_DATE, y, f"Closing Unit Balance: {scheme['close']}")
            c.drawString(160, y, f"NAV on {scheme['nav_date']}: INR {scheme['nav']}")
            c.drawString(300, y, f"Total Cost Value: {scheme['cost']}")
            c.drawString(410, y, f"Market Value on {scheme['nav_date']}: INR {scheme['value']}")
            c.setFont("Helvetica", 8)
            y -= 22
    c.save()
    return buf.getvalue()


CAMS_FOLIOS = [
    {
        "amc": "HDFC Mutual Fund",
        "folio": "1234567 / 89",
        "schemes": [
            {
                "code": "HFCDG",
                "name": "HDFC Flexi Cap Fund - Direct Plan - Growth Option",
                "isin": "INF179K01UT0",
                "advisor": "DIRECT",
                "open": "0.000",
                "close": "57.634",
                "nav_date": "10-Oct-2026",
                "nav": "2,012.3456",
                "cost": "1,05,000.00",
                "value": "1,15,977.43",
                "txns": [
                    ("15-Jan-2021", "Purchase", "50,000.00", "40.000", "1,250.0000", "40.000"),
                    ("15-Jan-2021", "*** Stamp Duty ***", "2.50"),
                    ("05-Feb-2022", "Systematic Investment Purchase -", "5,000.00", "3.876", "1,290.0000", "43.876", "Instalment 1/120"),
                    ("05-Mar-2022", "Systematic Investment Purchase -", "5,000.00", "4.000", "1,250.0000", "47.876", "Instalment 2/120"),
                    ("12-Mar-2022", "***Registration of Nominee***"),
                    ("05-Apr-2022", "Systematic Investment Purchase -", "5,000.00", "3.968", "1,260.0000", "51.844", "Instalment 3/120"),
                    ("20-Jun-2023", "Redemption", "(20,000.00)", "(12.000)", "1,666.6667", "39.844"),
                    ("01-Aug-2024", "Purchase", "40,000.00", "17.790", "2,248.4542", "57.634"),
                ],
            },
        ],
    },
    {
        "amc": "Parag Parikh Mutual Fund",
        "folio": "9988776",
        "schemes": [
            {
                "code": "PP001ZG",
                "name": "Parag Parikh Flexi Cap Fund - Direct Plan Growth",
                "isin": "INF879O01027",
                "advisor": "INA000001234",
                "open": "10.000",
                "close": "135.500",
                "nav_date": "10-Oct-2026",
                "nav": "92.1100",
                "cost": "8,500.00",
                "value": "12,480.91",
                "txns": [
                    ("10-May-2024", "Purchase", "6,000.00", "100.000", "60.0000", "110.000"),
                    ("01-Jul-2024", "IDCW Reinvestment @ Rs.2.00 per unit", "1,500.00", "25.500", "58.8235", "135.500"),
                ],
            },
        ],
    },
]

def long_sip_folio():
    """30 monthly SIPs: forces a page break where the table header is NOT repeated."""
    from decimal import Decimal
    txns, balance = [], Decimal("0.000")
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    for i in range(30):
        nav = Decimal("50.0000") + Decimal(i) * Decimal("0.7500")
        units = (Decimal("2000.00") / nav).quantize(Decimal("0.001"))
        balance += units
        date = f"07-{months[i % 12]}-{2023 + i // 12}"
        txns.append((date, f"SIP Purchase Instalment {i + 1}", "2,000.00", f"{units}", f"{nav:,}", f"{balance}"))
    return {
        "amc": "ICICI Prudential Mutual Fund",
        "folio": "5551234",
        "schemes": [{
            "code": "P8042",
            "name": "ICICI Prudential Nifty 50 Index Fund - Direct Plan - Growth",
            "isin": "INF109K012R6",
            "advisor": "DIRECT",
            "repeat_header": False,
            "open": "0.000",
            "close": f"{balance}",
            "nav_date": "10-Oct-2026",
            "nav": "75.5000",
            "cost": "60,000.00",
            "value": f"{(balance * Decimal('75.50')).quantize(Decimal('0.01')):,}",
            "txns": txns,
        }],
    }


CAMS_FOLIOS.append(long_sip_folio())

KFIN_FOLIOS = [
    {
        "amc": "Axis Mutual Fund",
        "folio": "91012345678",
        "schemes": [
            {
                "code": "128TSDGG",
                "name": "Axis ELSS Tax Saver Fund - Direct Growth",
                "isin": "INF846K01EW2",
                "advisor": "DIRECT",
                "open": "0.000",
                "close": "200.000",
                "nav_date": "10-Oct-2026",
                "nav": "105.5000",
                "cost": "15,000.00",
                "value": "21,100.00",
                "txns": [
                    ("01-Mar-2021", "Purchase", "10,000.00", "150.000", "66.6667", "150.000"),
                    ("01-Mar-2022", "Switch In - From Axis Liquid Fund", "5,000.00", "50.000", "100.0000", "200.000"),
                ],
            },
        ],
    },
]


def cdsl_statement():
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setFont("Helvetica", 9)
    # Page 1: cover
    c.drawString(40, H - 60, "Central Depository Services (India) Limited")
    c.drawString(40, H - 80, "Consolidated Account Statement")
    c.drawString(40, H - 100, "for the period from 01-09-2026 to 30-09-2026")
    c.showPage()
    # Page 2: investor block + roster
    c.setFont("Helvetica", 8)
    y = H - 60
    for text in ("CAS ID: 000000001", "ASHA VERMA", "12 EXAMPLE STREET", "PUNE", "PINCODE: 411001"):
        c.drawString(40, y, text)
        y -= 11
    y -= 30
    c.drawString(40, y, "In the single name of")
    y -= 14
    c.drawString(40, y, "ASHA VERMA (PAN:ABCDE1234F)")
    y -= 30
    for typ, broker, dp, client, isins, value in (
        ("CDSL Demat Account", "GROWW INVEST TECH PRIVATE LIMITED", "12088700", "12345678", "3", "1,10,450.00"),
        ("CDSL Demat Account", "BAJAJ FINANCIAL SECURITIES LIMITED", "12081600", "87654321", "1", "28,500.00"),
    ):
        c.drawString(40, y, typ)
        c.drawString(160, y, broker)
        c.drawString(160, y - 8, f"DP Id: {dp} Client Id : {client}")
        c.drawRightString(420, y, isins)
        c.drawRightString(540, y, value)
        y -= 30
    c.drawString(40, y, "Mutual Fund Folios")
    c.drawString(160, y, "2 Folios")
    c.drawRightString(420, y, "2")
    c.drawRightString(540, y, "45,678.90")
    c.showPage()

    # Page 3: per-account holdings
    def holdings(y, broker, bo_id, rows):
        c.drawString(40, y, f"DP Name : {broker}")
        c.drawString(330, y, f"BO ID : {bo_id}")
        y -= 24
        c.drawString(40, y, "HOLDING STATEMENT AS ON 30-09-2026")
        y -= 24
        headers = [(40, "ISIN"), (110, "Security"), (250, "Current Bal"), (305, "Frozen Bal"), (350, "Pledge Bal"),
                   (395, "Pledge Setup Bal"), (450, "Free Bal"), (490, "Market Price"), (545, "Value")]
        for x, label in headers:
            if x == 545:
                c.drawRightString(x, y, label)
            else:
                c.drawString(x, y, label)
        y -= 20
        for isin, name, bal, price, value in rows:
            c.drawString(40, y, isin)
            c.drawString(110, y, name)
            c.drawRightString(290, y, bal)
            c.drawRightString(335, y, "--")
            c.drawRightString(380, y, "--")
            c.drawRightString(430, y, "--")
            c.drawRightString(475, y, bal)
            c.drawRightString(515, y, price)
            c.drawRightString(560, y, value)
            y -= 20
        c.drawString(40, y, "Total")
        c.drawRightString(560, y, "0.00")
        return y - 34

    c.setFont("Helvetica", 7)
    y = H - 50
    y = holdings(y, "GROWW INVEST TECH PRIVATE LIMITED", "1208870012345678", [
        ("INE002A01018", "RELIANCE INDUSTRIES LIMITED", "20", "2,950.00", "59,000.00"),
        ("INE467B01029", "TATA CONSULTANCY SERVICES LTD", "10", "4,200.00", "42,000.00"),
        ("INF204KB14I2", "NIPPON INDIA ETF NIFTY BEES", "35", "270.00", "9,450.00"),
    ])
    y = holdings(y, "BAJAJ FINANCIAL SECURITIES LIMITED", "1208160087654321", [
        ("INE040A01034", "HDFC BANK LIMITED", "15", "1,900.00", "28,500.00"),
    ])
    c.drawString(40, y, "MUTUAL FUND UNITS HELD AS ON 30-09-2026")
    y -= 24
    for x, label in ((40, "Scheme Name"), (190, "ISIN"), (260, "Folio No."), (330, "Closing Bal"), (390, "NAV"),
                     (440, "Total Amount Invested"), (520, "Valuation")):
        c.drawString(x, y, label)
    y -= 20
    for name, isin, folio, units, nav, inv, val in (
        ("HFCDG - HDFC Flexi Cap Fund - Direct Growth", "INF179K01UT0", "1234567", "57.634", "2,012.3456", "1,05,000.00", "1,15,977.43"),
        ("PP001ZG - Parag Parikh Flexi Cap Fund", "INF879O01027", "9988776", "135.500", "92.1100", "8,500.00", "12,480.91"),
    ):
        c.drawString(40, y, name)
        c.drawString(190, y, isin)
        c.drawString(260, y, folio)
        c.drawRightString(370, y, units)
        c.drawRightString(425, y, nav)
        c.drawRightString(495, y, inv)
        c.drawRightString(560, y, val)
        y -= 20
    c.save()
    return buf.getvalue()


def encrypt(pdf_bytes, algorithm):
    reader = PdfReader(io.BytesIO(pdf_bytes))
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)
    writer.encrypt(user_password=PASSWORD, owner_password=PASSWORD + "-owner", algorithm=algorithm)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def main(out_dir):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    files = {
        "cams_detailed.pdf": encrypt(rta_statement("cams", "CAMSCASWS", "CAMS", CAMS_FOLIOS), "AES-256"),
        "kfin_detailed.pdf": encrypt(rta_statement("kfin", "KFINCASWS", "KFINTECH", KFIN_FOLIOS), "RC4-128"),
        "cdsl.pdf": encrypt(cdsl_statement(), "AES-128"),
    }
    for name, data in files.items():
        (out / name).write_bytes(data)
    print(json.dumps({"password": PASSWORD, "files": sorted(files)}))


if __name__ == "__main__":
    main(sys.argv[1])
