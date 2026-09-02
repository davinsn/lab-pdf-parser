# lab-pdf-parser

Hybrid parser for lab report PDFs. Tries fast, free, deterministic
"known-format" parsers first; falls back to AI extraction (Anthropic API)
for any report layout it hasn't been taught.

## How it works

```
PDF → extract text → known format? ──yes──→ regex/structure parser (free, instant)
                           │
                           no
                           ↓
                  AI extraction (Claude API)
                           │
                           ↓
              normalized measurements → CSV + charts
```

Both paths produce the same normalized shape (see `lib/schema.js`), so
downstream CSV export and charting work identically no matter which parser
handled a given PDF.

## Setup

```bash
npm install
```

To use the AI fallback, set your API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

(Get one at https://console.anthropic.com/settings/keys — without a key,
the tool still works fine on any PDF that matches a known format; it only
needs the key when it has to fall back to AI extraction.)

## Usage

```bash
node index.js path/to/report.pdf [--outdir OUT] [--force-ai]
```

- `--outdir DIR` — where to write outputs (default: `./output`)
- `--force-ai` — skip known-format detection and always use AI extraction
  (handy for testing, or if a known format is mis-detecting)

### Output files

- `extracted.json` — the full normalized data (useful for debugging or re-charting)
- `measurements.csv` — tidy `sample, analyte, value, unit, measurement_type` rows
- `chart_<type>_by_sample.svg` — one line chart per measurement type (e.g. recovery, concentration)
- `chart_<type>_heatmap.svg` — a sample × analyte heatmap per measurement type

SVGs open in any browser or image viewer — no extra tools needed.

## Teaching it a new known format

Known formats live in `lib/formats/`. Each one exports:

```js
module.exports = {
  name: "myFormat",
  detect(text) { /* return true/false: does this text look like my format? */ },
  parse(text)  { /* return a NormalizedDoc: { documentType, parserUsed, metadata, measurements } */ },
};
```

Register it in `lib/formats/index.js`. Known formats are tried in order
before the AI fallback — so any report layout you see often can skip the
API call (and its cost/latency) entirely. See `lib/formats/qcReport.js`
for a complete worked example.

## Notes on the AI fallback

- Uses `claude-sonnet-5` by default. Override with `ANTHROPIC_MODEL` env var.
- Document text is truncated to 100,000 characters before sending, to keep
  cost/latency bounded on very long reports. A truncation warning is added
  to `metadata._warning` if this happens.
- AI extraction is not perfectly deterministic — spot-check `extracted.json`
  against the source PDF, especially for anything you'll rely on downstream.
