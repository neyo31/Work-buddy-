"""Generate single-use token codes.
Outputs (in ./out):
  pdf/tokens_001.pdf ...   the codes (keep PRIVATE, give to your payment site)
  hashes/hashes_001.csv    sha256 hashes (import into the Supabase `codes` table)
Only hashes go to the WorkBuddy site, so a database leak reveals no usable codes.
Usage: python3 tools/make_codes.py [total=2000000] [per_file=100000]
"""
import sys, os, secrets, hashlib
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

TOTAL = int(sys.argv[1]) if len(sys.argv) > 1 else 2_000_000
PER = int(sys.argv[2]) if len(sys.argv) > 2 else 100_000
A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no look-alike characters
def rnd(n): return "".join(secrets.choice(A) for _ in range(n))
def code(): return f"WB-{rnd(5)}-{rnd(5)}-{rnd(5)}"   # ~74 bits, impossible to guess

os.makedirs("out/pdf", exist_ok=True); os.makedirs("out/hashes", exist_ok=True)
seen = set(); n = 0; files = (TOTAL + PER - 1) // PER
W, H = A4; cols, rows = 4, 62
cw, rh = (W - 40) / cols, (H - 60) / rows
for f in range(1, files + 1):
    c = canvas.Canvas(f"out/pdf/tokens_{f:03d}.pdf", pagesize=A4)
    h = open(f"out/hashes/hashes_{f:03d}.csv", "w")
    h.write("hash,n\n")
    batch = min(PER, TOTAL - n); i = 0
    while i < batch:
        c.setFont("Helvetica-Bold", 8); c.drawString(20, H - 24, f"WorkBuddy tokens - file {f}/{files} - 1 code = 1 token. Keep private.")
        c.setFont("Courier", 6.2)
        for r in range(rows):
            for k in range(cols):
                if i >= batch: break
                x = code()
                while x in seen: x = code()
                seen.add(x); n += 1; i += 1
                h.write(f"{hashlib.sha256(x.encode()).hexdigest()},{n}\n")
                c.drawString(20 + k * cw, H - 40 - r * rh, f"{n:07d} {x}")
        c.showPage()
    c.save(); h.close()
    print("file", f, "done", n, flush=True)
print("total", n)
