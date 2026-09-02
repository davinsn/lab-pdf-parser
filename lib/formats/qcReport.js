/**
 * Known-format parser: ICP-OES/ICP-MS "QC" style reports
 * (the "Sample Result" export with element/wavelength columns and a
 * "Reported" recovery-% row per run, e.g. 260813_-_QC.pdf).
 *
 * Every known-format module exports:
 *   - name: string, a short id for logging
 *   - detect(text): boolean -- cheap check, does this text look like our format?
 *   - parse(text): NormalizedDoc -- full parse, only called if detect() passed
 *
 * See lib/schema.js for the NormalizedDoc shape.
 */

const ELEMENT_TOKEN_RE = /([A-Z][a-z]?\s\d{3}\.\d{3})/g;
const PCT_VALUE_RE = /(-?\d+\.?\d*)\s*%/g;
const RUN_START_RE = /^\s*(\d+)\.\s*(.+?)\s*$/;

function findElementHeaders(text) {
  const lines = text.split("\n");
  for (const line of lines) {
    const matches = [...line.matchAll(ELEMENT_TOKEN_RE)].map((m) => m[1]);
    if (matches.length >= 3) return matches;
  }
  return null;
}

function detect(text) {
  // Cheap, specific signals that this is *this* report family.
  return /Sample Result/.test(text) && /Reported\b/.test(text) && !!findElementHeaders(text);
}

function parse(text) {
  const elements = findElementHeaders(text);
  const lines = text.split("\n");

  const runStarts = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(RUN_START_RE);
    if (!m) continue;
    const hasLetters = /[A-Za-z]/.test(m[2] || "");
    const isShort = line.trim().split(/\s+/).length <= 6;
    const hasPct = /%/.test(line);
    if (hasLetters && isShort && !hasPct) {
      runStarts.push({ index: i, label: line.trim() });
    }
  }

  const measurements = [];
  for (let idx = 0; idx < runStarts.length; idx++) {
    const start = runStarts[idx].index;
    const end = idx + 1 < runStarts.length ? runStarts[idx + 1].index : lines.length;
    const block = lines.slice(start, end);
    const label = runStarts[idx].label;

    const reportedLine = block.find((l) => /^Reported\b/.test(l.trim()));
    if (!reportedLine) continue;

    const values = [...reportedLine.matchAll(PCT_VALUE_RE)].map((m) => parseFloat(m[1]));
    if (values.length !== elements.length) continue;

    elements.forEach((element, i) => {
      measurements.push({
        sample: label,
        analyte: element,
        value: values[i],
        unit: "%",
        measurementType: "recovery",
      });
    });
  }

  const methodMatch = text.match(/Method\s+([^\n]+)/);

  return {
    documentType: "ICP QC Report",
    parserUsed: "known:qcReport",
    metadata: {
      method: methodMatch ? methodMatch[1].trim() : null,
    },
    measurements,
  };
}

module.exports = { name: "qcReport", detect, parse };
