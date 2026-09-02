/**
 * AI extraction fallback. Used when no known-format parser (lib/formats/*)
 * recognizes the PDF's layout. Sends the extracted text to the Anthropic
 * API and asks for the same NormalizedDoc shape (see lib/schema.js) that
 * the known-format parsers produce, so everything downstream (CSV, charts)
 * works the same regardless of which path parsed the document.
 *
 * Requires an ANTHROPIC_API_KEY environment variable. Get one at
 * https://console.anthropic.com/settings/keys
 *
 * Model: this defaults to "claude-sonnet-5" (a good balance of quality and
 * cost for extraction). Override with the ANTHROPIC_MODEL env var if you
 * want to use a different model.
 */

require("dotenv").config();
const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

const SYSTEM_PROMPT = `You extract structured data from lab report PDFs (assay certificates, QC reports, calibration reports, certificates of analysis, method validation reports, etc.). The report format varies -- your job is to read it like a scientist would and pull out every sample/analyte/value triple you can find, regardless of layout.

Return ONLY valid JSON (no markdown fences, no commentary) matching exactly this shape:

{
  "documentType": "<short description of what kind of report this is>",
  "metadata": { "<any doc-level fields you notice, e.g. method, date, lab, operator>": "<value>" },
  "measurements": [
    {
      "sample": "<which sample/run/specimen this belongs to>",
      "analyte": "<what was measured, e.g. element name, compound, test name>",
      "value": <number>,
      "unit": "<%, ppm, mg/L, etc. -- empty string if unitless>",
      "measurementType": "<what kind of value this is, e.g. recovery, concentration, result, RSD>"
    }
  ]
}

Rules:
- "value" must be a plain number (no % sign, no units in the number itself).
- If a report shows the same analyte multiple ways (e.g. raw concentration AND % recovery), include both as separate measurements with different measurementType.
- If you truly cannot find any tabular/numeric measurement data, return "measurements": [].
- Do not invent data that isn't in the text.`;

async function aiExtract(text) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No ANTHROPIC_API_KEY environment variable set. Get a key at " +
        "https://console.anthropic.com/settings/keys and set it, e.g.:\n" +
        "  export ANTHROPIC_API_KEY=sk-ant-...\n" +
        "(Windows PowerShell: $env:ANTHROPIC_API_KEY = \"sk-ant-...\")"
    );
  }

  // Guard against extremely long documents blowing the context/cost budget.
  const MAX_CHARS = 100000;
  const truncated = text.length > MAX_CHARS;
  const inputText = truncated ? text.slice(0, MAX_CHARS) : text;

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID || ""
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Extract the structured data from this lab report text:\n\n${inputText}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Anthropic API error ${response.status}: ${body}`);
  }

  const data = await response.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) {
    throw new Error("AI response had no text content to parse.");
  }

  const cleaned = textBlock.text.replace(/^```json\s*|```\s*$/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `AI response wasn't valid JSON (${err.message}). Raw response:\n${textBlock.text.slice(0, 500)}`
    );
  }

  if (truncated) {
    parsed.metadata = parsed.metadata || {};
    parsed.metadata._warning = `Document text was truncated to ${MAX_CHARS} characters before extraction.`;
  }

  return {
    documentType: parsed.documentType || "Unknown lab report",
    parserUsed: "ai:" + DEFAULT_MODEL,
    metadata: parsed.metadata || {},
    measurements: Array.isArray(parsed.measurements) ? parsed.measurements : [],
  };
}

module.exports = { aiExtract };
