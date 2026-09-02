#!/usr/bin/env node
/**
 * lab-pdf-parser
 *
 * Hybrid parser for lab report PDFs.
 *   1. Extracts text from the PDF (pdf-parse).
 *   2. Tries each known-format parser (lib/formats/*) -- fast, free,
 *      deterministic, but only works on layouts it's been taught.
 *   3. If none match, falls back to AI extraction (lib/aiExtract.js) via
 *      the Anthropic API -- slower and needs an API key, but adapts to
 *      almost any lab report layout.
 *   4. Writes out a normalized CSV and two SVG charts (line + heatmap)
 *      from whichever parser produced the data.
 *
 * USAGE
 * -----
 *   export ANTHROPIC_API_KEY=sk-ant-...        # needed for AI fallback
 *   node index.js path/to/report.pdf [--outdir OUT] [--force-ai]
 *
 * Flags:
 *   --outdir DIR   Where to write outputs (default: ./output)
 *   --force-ai     Skip known-format detection, always use AI extraction
 *                  (useful for testing / when a known format mis-detects)
 *
 * ADDING A NEW KNOWN FORMAT
 * --------------------------
 * Drop a new file in lib/formats/ exporting { name, detect(text), parse(text) }
 * (see lib/formats/qcReport.js for a full example) and register it in
 * lib/formats/index.js. It'll be tried before the AI fallback, so any report
 * layout you see often can skip the API call entirely.
 */

const fs = require("fs");
const path = require("path");

const { findKnownFormat } = require("./lib/formats");
const { aiExtract } = require("./lib/aiExtract");
const { toCsv } = require("./lib/csv");
const { buildLineChart, buildHeatmap } = require("./lib/chart");

function parseArgs(argv) {
  const args = { outdir: "output", forceAi: false, pdfPath: null };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--outdir") args.outdir = rest[++i];
    else if (a === "--force-ai") args.forceAi = true;
    else if (!args.pdfPath) args.pdfPath = a;
  }
  if (!args.pdfPath) {
    console.error("Usage: node index.js path/to/report.pdf [--outdir OUT] [--force-ai]");
    process.exit(1);
  }
  return args;
}

async function extractText(pdfPath) {
  const { PDFParse } = require("pdf-parse");
  const buffer = fs.readFileSync(pdfPath);
  const parser = new PDFParse({ data: buffer });
  const { text } = await parser.getText();
  await parser.destroy();
  return text;
}

async function main() {
  const args = parseArgs(process.argv);

  console.log(`Reading ${args.pdfPath} ...`);
  const text = await extractText(args.pdfPath);

  let doc;

  if (!args.forceAi) {
    const format = findKnownFormat(text);
    if (format) {
      console.log(`Matched known format: "${format.name}" -- parsing without AI.`);
      doc = format.parse(text);
    }
  }

  if (!doc) {
    console.log("No known format matched -- falling back to AI extraction ...");
    doc = await aiExtract(text);
  }

  console.log(`Document type: ${doc.documentType}`);
  console.log(`Parser used:   ${doc.parserUsed}`);
  console.log(`Measurements:  ${doc.measurements.length}`);

  if (doc.measurements.length === 0) {
    console.log("No measurements found -- nothing to chart. Raw metadata:", doc.metadata);
    return;
  }

  fs.mkdirSync(args.outdir, { recursive: true });

  // Save the full normalized JSON (useful for debugging / re-charting later)
  const jsonPath = path.join(args.outdir, "extracted.json");
  fs.writeFileSync(jsonPath, JSON.stringify(doc, null, 2));
  console.log(`Saved: ${jsonPath}`);

  // Save CSV
  const csvPath = path.join(args.outdir, "measurements.csv");
  fs.writeFileSync(csvPath, toCsv(doc.measurements));
  console.log(`Saved: ${csvPath}`);

  // Chart per measurementType, since different types (recovery vs.
  // concentration vs. RSD) shouldn't share one y-axis.
  const types = [...new Set(doc.measurements.map((m) => m.measurementType || "value"))];

  for (const type of types) {
    const subset = doc.measurements.filter((m) => (m.measurementType || "value") === type);
    const safeName = type.toLowerCase().replace(/[^a-z0-9]+/g, "_");

    const linePath = path.join(args.outdir, `chart_${safeName}_by_sample.svg`);
    fs.writeFileSync(
      linePath,
      buildLineChart(subset, { title: `${doc.documentType}: ${type}`, yLabel: subset[0].unit })
    );
    console.log(`Saved: ${linePath}`);

    const heatmapPath = path.join(args.outdir, `chart_${safeName}_heatmap.svg`);
    fs.writeFileSync(heatmapPath, buildHeatmap(subset, { title: `${type} Heatmap` }));
    console.log(`Saved: ${heatmapPath}`);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
