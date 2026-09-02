# pdf-parser-json

Extracts text and lightweight structure from a general/mixed PDF into JSON, with an
optional final pass where Gemini verifies the extraction against the source text.

## What it extracts

- Raw text (whole document + per-page)
- Paragraphs (split on blank-line gaps)
- Candidate section headings (short, capitalized standalone lines)
- Entities: emails, URLs, dates, currency amounts, phone numbers
- PDF metadata (title, author, producer, page count, etc., as embedded in the file)

## Setup

```bash
npm install
cp .env.example .env
# then edit .env and set GEMINI_API_KEY=your-key-here
# (get a key at https://aistudio.google.com/apikey)
```

Requires Node.js 18+ (uses the built-in `fetch`).

## Usage

```bash
# Extract only, writes <input-name>.json next to the PDF
node src/index.js path/to/document.pdf

# Extract + verify with Gemini, custom output path
node src/index.js path/to/document.pdf --verify --out result.json
```

Flags:
- `--verify` / `-v` — sends the extracted structure (and up to ~15k chars of raw
  text) to Gemini, which checks it for missed entities, mislabeled headings, or
  other gaps, and returns a verification report merged into the output JSON.
- `--out` / `-o` — output path (default: same name as the input, `.json` instead
  of `.pdf`).

## Output shape

```jsonc
{
  "source": { "filePath": "...", "byteSize": 12345 },
  "metadata": { "pageCount": 3, "info": { "Title": "...", "Author": "..." } },
  "content": {
    "rawText": "...",
    "pages": ["page 1 text", "page 2 text", "..."],
    "paragraphs": ["...", "..."],
    "paragraphCount": 7,
    "detectedHeadings": ["INTRODUCTION", "SUMMARY"]
  },
  "entities": {
    "email": ["jane@example.com"],
    "url": ["https://example.com"],
    "date": ["2026-08-15"],
    "currency": ["$45,300.00"],
    "phone": ["(555) 123-4567"]
  },
  "extractedAt": "2026-09-02T05:33:04.766Z",
  "verification": {
    "ok": true,
    "model": "gemini-2.0-flash",
    "verified": true,
    "confidence": 0.92,
    "issues": [],
    "missedEntities": { "email": [], "url": [], "date": [], "currency": [], "phone": [] },
    "notes": "Extraction matches the source text; all detected entities are accurate."
  }
}
```

If `--verify` is used without `GEMINI_API_KEY` set, extraction still runs and the
error is recorded under `verification.error` rather than failing the whole run.

## Notes on the heuristics

- **Headings** are detected by a simple rule (short line, mostly capitalized words,
  no trailing punctuation) — good for reports/memos with clear section titles,
  less reliable on dense prose or heavily styled documents.
- **Entities** use regexes, not NLP — phone number and date matching in particular
  can produce false positives/negatives on unusual formats. This is exactly what
  the `--verify` pass is meant to catch: point Gemini at the raw text and it will
  flag anything the regexes missed or mislabeled.
- **Scanned PDFs** (image-only pages) won't yield text — this pipeline doesn't do
  OCR. If you need that, add a `pdf2image` + OCR step before `extractPdf`.

## Files

- `src/pdfExtractor.js` — PDF → structured JSON (uses `pdfjs-dist`)
- `src/geminiVerifier.js` — sends the extraction to Gemini for a verification pass
- `src/index.js` — CLI entry point