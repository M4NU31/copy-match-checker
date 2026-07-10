# Generates a realistic .docx with color-coded runs + an SEO/Yoast table,
# intro/meta lines, pink instructions and a green alternate — to test that the
# tool ignores scaffolding and handles green/pink correctly. Stdlib only.
import zipfile, os
HERE = os.path.dirname(os.path.abspath(__file__))

def esc(s): return s.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;")

def run(text, color=None):
    rpr = f'<w:rPr><w:color w:val="{color}"/></w:rPr>' if color else ''
    return f'<w:r>{rpr}<w:t xml:space="preserve">{esc(text)}</w:t></w:r>'

def para(text, color=None):
    return f'<w:p>{run(text, color)}</w:p>'

def cell(text):
    return f'<w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>{para(text)}</w:tc>'

def row(a, b):
    return f'<w:tr>{cell(a)}{cell(b)}</w:tr>'

GREEN = "00B050"
PINK  = "E6007E"

body = "".join([
    para("Fortreum: High Value Pages"),                 # scaffold (value pages)
    para("Services > FedRAMP"),                          # scaffold (breadcrumb)
    para("/fedramp"),                                    # scaffold (slug)
    para("Page Goal: Convert Cloud Service Providers researching FedRAMP authorization"),  # scaffold (meta)
    para("Goal CTA: Request a FedRAMP Readiness Review"),# scaffold (meta)
    # SEO / Yoast table -> whole table ignored
    f'<w:tbl><w:tblPr><w:tblW w:w="8000" w:type="dxa"/></w:tblPr>'
    + row("Page SEO Info", "Copy from here to propagate Yoast")
    + row("Header (H1)/Title", "FedRAMP")
    + row("Focus Keyphrase", "FedRAMP 3PAO")
    + row("Meta Description - no more than 156 characters",
          "Fortreum is a Top 5 FedRAMP 3PAO. Accelerate your cloud authorization.")
    + '</w:tbl>',
    para("[Card 1]", PINK),                              # instruction (pink + bracket)
    para("How Fortreum Works With You", PINK),           # instruction (pink)
    para("From Gap Assessment to Authorization. No Surprises."),  # normal heading
    para("We map your controls against FedRAMP baselines, surface gaps before they become formal findings, and deliver a prioritized remediation roadmap."),  # normal (long)
    para("We map controls, surface gaps, and deliver a prioritized remediation roadmap.", GREEN),  # green alternate of the above
    para("Request a FedRAMP Readiness Review"),          # normal CTA
    para("[Explore XRAMP] (/xramp)", "1155CC"),          # blue bracketed CTA button -> must be on site
])

document = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
  f'<w:body>{body}</w:body></w:document>')
content_types = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  '<Default Extension="xml" ContentType="application/xml"/>'
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  '</Types>')
rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')

path = os.path.join(HERE, "Fortreum_FedRAMP_Approved.docx")
with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", content_types)
    z.writestr("_rels/.rels", rels)
    z.writestr("word/document.xml", document)
print("Created", os.path.basename(path))
