/**
 * NormalizedDoc -- the common shape every parser (known-format or AI
 * fallback) must produce, so downstream code (CSV export, charts) doesn't
 * care which path parsed the PDF.
 *
 * {
 *   documentType: string,        // e.g. "ICP QC Report", "Certificate of Analysis"
 *   parserUsed: string,          // e.g. "known:qcReport" or "ai"
 *   metadata: {                  // free-form, whatever context is useful
 *     method: string | null,
 *     ... any other doc-level fields (date, lab, operator, etc.)
 *   },
 *   measurements: [
 *     {
 *       sample: string,          // which sample/run/specimen this belongs to
 *       analyte: string,         // what was measured (element, compound, test name...)
 *       value: number,           // the numeric result
 *       unit: string,            // "%", "ppm", "mg/L", etc.
 *       measurementType: string, // "recovery", "concentration", "result", etc.
 *     },
 *     ...
 *   ]
 * }
 *
 * This is intentionally loose (measurementType and unit are free text) because
 * different lab report types measure very different things. The chart code
 * groups by (analyte, measurementType) and plots value across samples --
 * that generalizes across formats as long as parsers stick to this shape.
 */
module.exports = {};
