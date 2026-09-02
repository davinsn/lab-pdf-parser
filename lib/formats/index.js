/**
 * Registry of known-format parsers. Add a new module here (same shape as
 * qcReport.js: { name, detect(text), parse(text) }) to teach the hybrid
 * parser a new lab-report layout without touching the AI fallback at all.
 */
const qcReport = require("./qcReport");

const KNOWN_FORMATS = [qcReport];

/**
 * Try each known-format parser's detect(). Returns the first one that
 * matches, or null if none do (caller should fall back to AI extraction).
 */
function findKnownFormat(text) {
  for (const format of KNOWN_FORMATS) {
    if (format.detect(text)) return format;
  }
  return null;
}

module.exports = { KNOWN_FORMATS, findKnownFormat };
