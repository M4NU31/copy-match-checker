# Generates a real .docx and .pdf using only the Python standard library.
# Content mirrors example.com so we can compare against the live URL.
import zipfile, os

HERE = os.path.dirname(os.path.abspath(__file__))

LINES = [
    "Example Domain",
    "This domain is for use in illustrative examples in documents. "
    "You may use this domain in literature without prior coordination or asking for permission.",
    "More information...",
    "Contact our team to request a Cybersecurity Maturity Model Certification (CMMC) assessment.",
]

# ---------- DOCX (Office Open XML = a zip of XML parts) ----------
def make_docx(path):
    def esc(s):
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    paras = "".join(
        f'<w:p><w:r><w:t xml:space="preserve">{esc(l)}</w:t></w:r></w:p>' for l in LINES
    )
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f'<w:body>{paras}</w:body></w:document>'
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '</Types>'
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="word/document.xml"/></Relationships>'
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", document)

# ---------- PDF (minimal one-page text PDF) ----------
def make_pdf(path):
    def pdf_esc(s):
        return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
    # build text content stream: one line per Td move
    y = 760
    stream_lines = ["BT", "/F1 12 Tf", "14 TL", f"72 {y} Td"]
    for i, l in enumerate(LINES):
        # wrap long lines crudely so they fit
        chunk = l
        first = True
        while chunk:
            part, chunk = chunk[:90], chunk[90:]
            if not first:
                stream_lines.append("T*")
            stream_lines.append(f"({pdf_esc(part)}) Tj")
            first = False
        stream_lines.append("T*")  # blank line between paragraphs
    stream_lines.append("ET")
    stream = "\n".join(stream_lines).encode("latin-1")

    objs = []
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
    objs.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>")
    objs.append(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream")
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_pos = len(out)
    out += f"xref\n0 {len(objs)+1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += b"trailer\n"
    out += f"<< /Size {len(objs)+1} /Root 1 0 R >>\n".encode()
    out += b"startxref\n" + str(xref_pos).encode() + b"\n%%EOF"
    with open(path, "wb") as f:
        f.write(out)

make_docx(os.path.join(HERE, "Example_Approved.docx"))
make_pdf(os.path.join(HERE, "Example_Approved.pdf"))
print("Created Example_Approved.docx and Example_Approved.pdf")
print("Lines:", len(LINES))
