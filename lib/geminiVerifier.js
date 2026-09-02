const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

/**
 * Asks Gemini to sanity-check the structured extraction against the raw PDF text:
 * did we miss obvious entities, mislabel headings, truncate anything, etc.
 *
 * @param {object} extraction - the object returned by extractPdf()
 * @param {object} [opts]
 * @param {string} [opts.apiKey] - defaults to process.env.GEMINI_API_KEY
 * @param {string} [opts.model] - defaults to process.env.GEMINI_MODEL or gemini-2.0-flash
 * @returns {Promise<object>} verification result (parsed JSON) merged with raw model text as fallback
 */
export async function verifyWithGemini(extraction, opts = {}) {
  const apiKey = opts.apiKey || process.env.GEMINI_API_KEY;
  const model = opts.model || DEFAULT_MODEL;

  if (!apiKey) {
    throw new Error(
      "Missing Gemini API key. Set GEMINI_API_KEY in your .env file or pass { apiKey } explicitly."
    );
  }

  // Cap how much raw text we send if the document is huge, to keep requests fast/cheap.
  const MAX_CHARS = 15000;
  const rawText = extraction.content.rawText.slice(0, MAX_CHARS);
  const truncated = extraction.content.rawText.length > MAX_CHARS;

  const prompt = `You are verifying an automated PDF-to-JSON extraction pipeline.

Below is (1) the raw text extracted from a PDF and (2) the structured JSON the pipeline produced from it (entities, detected headings, paragraph count).

Check the structured output against the raw text and respond with ONLY a JSON object (no markdown fences, no commentary) matching this schema:
{
  "verified": boolean,            // true if the extraction looks accurate and reasonably complete
  "confidence": number,           // 0-1
  "issues": string[],             // specific problems found, e.g. "missed email x@y.com", "heading list includes a non-heading line"
  "missedEntities": {             // entities present in raw text but absent from the JSON's entities block, if any
    "email": string[],
    "url": string[],
    "date": string[],
    "currency": string[],
    "phone": string[]
  },
  "notes": string                 // brief free-text summary
}

RAW TEXT${truncated ? " (truncated)" : ""}:
"""
${rawText}
"""

STRUCTURED JSON PRODUCED:
"""
${JSON.stringify(
    {
      metadata: extraction.metadata,
      paragraphCount: extraction.content.paragraphCount,
      detectedHeadings: extraction.content.detectedHeadings,
      entities: extraction.entities,
    },
    null,
    2
  )}
"""`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json" },
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";

  try {
    const cleaned = text.replace(/^```json\s*|```\s*$/g, "").trim();
    return { ok: true, model, ...JSON.parse(cleaned) };
  } catch {
    // Fall back to returning raw model text if it didn't produce valid JSON.
    return { ok: false, model, rawModelText: text };
  }
}