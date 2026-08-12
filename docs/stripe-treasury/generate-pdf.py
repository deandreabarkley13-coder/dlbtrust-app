#!/usr/bin/env python3
"""Generate the Stripe Treasury compliance package PDF."""

import sys
import os
import markdown
from weasyprint import HTML, CSS

HERE = os.path.dirname(os.path.abspath(__file__))
MD_PATH = os.path.join(HERE, 'compliance-package.md')
OUT_PATH = os.path.join(HERE, '../../public/trust-portal/stripe-treasury-compliance-package.pdf')

CSS_TEXT = """
@page {
  size: letter;
  margin: 0.75in 0.8in 0.85in 0.8in;
  @bottom-center { content: "Page " counter(page) " of " counter(pages); font-size: 9pt; color: #555; }
}
body {
  font-family: "DejaVu Sans", "Liberation Sans", "Arial", sans-serif;
  font-size: 10.5pt;
  line-height: 1.5;
  color: #1a1a1a;
}
h1 {
  font-size: 20pt;
  color: #0b1f3a;
  border-bottom: 2px solid #c9a227;
  padding-bottom: 0.2em;
  margin-top: 0;
}
h2 {
  font-size: 14pt;
  color: #0b1f3a;
  margin-top: 1.4em;
  border-bottom: 1px solid #ddd;
  padding-bottom: 0.15em;
}
h3 {
  font-size: 12pt;
  color: #0b1f3a;
  margin-top: 1.2em;
}
hr {
  border: none;
  border-top: 1px solid #ddd;
  margin: 1.2em 0;
}
table {
  width: 100%;
  border-collapse: collapse;
  margin: 1em 0;
  font-size: 10pt;
}
th, td {
  border: 1px solid #bbb;
  padding: 6px 8px;
  text-align: left;
  vertical-align: top;
}
th {
  background: #eef2f7;
  font-weight: bold;
}
tr:nth-child(even) {
  background: #f9f9f9;
}
ul, ol {
  margin: 0.8em 0;
  padding-left: 1.5em;
}
li {
  margin: 0.25em 0;
}
p {
  margin: 0.8em 0;
}
code {
  font-family: "DejaVu Sans Mono", monospace;
  background: #f4f4f4;
  padding: 0.1em 0.3em;
  border-radius: 3px;
}
strong {
  color: #0b1f3a;
}
"""

def main():
    if not os.path.exists(MD_PATH):
        print(f"Markdown not found: {MD_PATH}", file=sys.stderr)
        sys.exit(1)
    with open(MD_PATH, 'r', encoding='utf-8') as f:
        md = f.read()
    html_body = markdown.markdown(md, extensions=['tables', 'fenced_code'])
    html = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Stripe Treasury Compliance Package</title>
</head>
<body>
{html_body}
</body>
</html>"""
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    HTML(string=html).write_pdf(OUT_PATH, stylesheets=[CSS(string=CSS_TEXT)])
    print(f"PDF written to: {OUT_PATH}")

if __name__ == '__main__':
    main()
