const DEFAULT_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.6-flash";


/**
 * ============================================================
 * Gemini PDF Extraction Verifier
 * ============================================================
 *
 * Gemini is ONLY used as a verification / quality-control
 * layer.
 *
 * The PDF is extracted deterministically first.
 * Gemini checks whether that extraction appears correct.
 *
 * Gemini does NOT perform the primary extraction.
 */


/**
 * Verify deterministic PDF extraction with Gemini.
 *
 * @param {object} extraction
 * @param {object} [opts]
 * @param {string} [opts.apiKey]
 * @param {string} [opts.model]
 * @returns {Promise<object>}
 */

export async function verifyWithGemini(
  extraction,
  opts = {}
) {

  /**
   * ----------------------------------------------------------
   * Configuration
   * ----------------------------------------------------------
   */

  const apiKey =
    opts.apiKey ||
    process.env.GEMINI_API_KEY;

  const model =
    opts.model ||
    DEFAULT_MODEL;


  if (!apiKey) {
    throw new Error(
      "Missing Gemini API key. Set GEMINI_API_KEY in your .env file or pass { apiKey } explicitly."
    );
  }


  /**
   * ----------------------------------------------------------
   * Validate extraction object
   * ----------------------------------------------------------
   *
   * New structure:
   *
   * extraction
   * ├── metadata
   * ├── document
   * ├── entities
   * ├── extraction
   * └── rawText
   */

  if (
    !extraction ||
    typeof extraction !== "object" ||
    !extraction.document
  ) {

    throw new Error(
      "Invalid extraction object. Expected an object returned by extractPdf()."
    );
  }


  /**
   * ----------------------------------------------------------
   * Limit text sent to Gemini
   * ----------------------------------------------------------
   */

  const MAX_CHARS = 15000;

  const fullRawText =
    extraction.rawText || "";

  const rawText =
    fullRawText.slice(0, MAX_CHARS);

  const truncated =
    fullRawText.length > MAX_CHARS;


  /**
   * ----------------------------------------------------------
   * Prepare structured extraction for verification
   * ----------------------------------------------------------
   *
   * We send the actual structured output produced by
   * extractPdf().
   */

  const document =
    extraction.document || {};

  const structuredExtraction = {

    title:
      document.title || null,

    fields:
      document.fields || {},

    headings:
      document.headings || [],

    blocks:
      document.blocks || [],

    paragraphs:
      document.paragraphs || [],

    paragraphCount:
      document.paragraphCount || 0,

    tables:
      document.tables || [],

    entities:
      extraction.entities || {},

    extractionStats:
      extraction.extraction || null
  };


  /**
   * ----------------------------------------------------------
   * Gemini prompt
   * ----------------------------------------------------------
   */

  const prompt = `
You are a quality-control verifier for an automated
generic PDF-to-JSON extraction pipeline.

IMPORTANT:

The PDF has already been processed by deterministic code.

Your job is ONLY to verify whether the deterministic
extraction accurately represents the raw PDF text.

Do NOT perform the primary extraction.

Do NOT invent information.

Do NOT rewrite the document.

Do NOT create domain-specific assumptions.

Check whether the structured extraction correctly represents
the raw PDF text.

Check for:

1. Missing fields
2. Incorrect fields
3. Missing headings
4. Incorrect headings
5. Missing tables
6. Incorrect table structures
7. Missing entities
8. Incorrect entities
9. False-positive entities
10. Missing paragraphs or text blocks
11. Truncated extraction
12. Obvious structural problems

Pay particular attention to:

- dates
- numbers
- percentages
- currency
- URLs
- email addresses
- phone numbers
- table values
- field/value pairs

Do NOT assume a number is a phone number merely because
it contains digits.

For example:

418.660
0.001239
0.999024
260813

may be scientific measurements, identifiers, wavelengths,
correlation values, method numbers, etc.

Only identify them as phone numbers if the raw text clearly
supports that interpretation.

The parser is intended to work with ANY type of PDF.

Do not assume the document is a laboratory report,
certificate, invoice, academic paper, or any other specific
document type.

Respond with ONLY valid JSON.

Do not use markdown.

Do not use code fences.

Do not include explanatory text outside the JSON.

Use exactly this structure:

{
  "verified": true,
  "confidence": 0.95,
  "issues": [],
  "missedEntities": {
    "email": [],
    "url": [],
    "date": [],
    "currency": [],
    "phone": []
  },
  "notes": "Brief summary of the verification."
}

Definitions:

"verified":

true only when the structured extraction is reasonably
accurate.

false when there are meaningful extraction or structural
errors.

"confidence":

A number between 0 and 1 representing your confidence in
the verification.

"issues":

A list of specific problems found in the deterministic
extraction.

Examples:

"Date entity 20-Aug-2026 is missing."

"The table appears to contain five columns, but the
structured extraction contains zero tables."

"A field value appears to have been truncated."

"Phone entity list contains a scientific measurement."

"missedEntities":

Entities that clearly appear in the raw PDF text but are
missing from the corresponding structured entity list.

"notes":

A short summary of the overall extraction quality.


============================================================
RAW PDF TEXT
============================================================

${truncated
  ? "WARNING: The raw PDF text was truncated to 15,000 characters."
  : ""
}

"""
${rawText}
"""


============================================================
STRUCTURED EXTRACTION
============================================================

"""
${JSON.stringify(
  structuredExtraction,
  null,
  2
)}
"""
`;


  /**
   * ----------------------------------------------------------
   * Gemini REST API
   * ----------------------------------------------------------
   */

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;


  let response;


  try {

    response =
      await fetch(
        url,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({

              contents: [
                {
                  role: "user",

                  parts: [
                    {
                      text: prompt
                    }
                  ]
                }
              ],

              generationConfig: {

                temperature: 0,

                responseMimeType:
                  "application/json"
              }
            })
        }
      );

  } catch (error) {

    throw new Error(
      `Failed to connect to Gemini API: ${error.message}`
    );
  }


  /**
   * ----------------------------------------------------------
   * Handle API errors
   * ----------------------------------------------------------
   */

  if (!response.ok) {

    const errorText =
      await response
        .text()
        .catch(() => "");

    throw new Error(
      `Gemini API error ${response.status}: ${errorText}`
    );
  }


  /**
   * ----------------------------------------------------------
   * Parse Gemini response
   * ----------------------------------------------------------
   */

  const data =
    await response.json();


  const text =
    data
      ?.candidates?.[0]
      ?.content?.parts
      ?.map(
        (part) =>
          part.text || ""
      )
      .join("")
      .trim() || "";


  /**
   * ----------------------------------------------------------
   * Empty response
   * ----------------------------------------------------------
   */

  if (!text) {

    return {

      ok: false,

      model,

      error:
        "Gemini returned an empty response.",

      rawResponse:
        data
    };
  }


  /**
   * ----------------------------------------------------------
   * Parse verification JSON
   * ----------------------------------------------------------
   */

  try {

    const cleaned =
      text
        .replace(
          /^```json\s*/i,
          ""
        )
        .replace(
          /^```\s*/i,
          ""
        )
        .replace(
          /\s*```$/i,
          ""
        )
        .trim();


    const verification =
      JSON.parse(cleaned);


    return {

      ok: true,

      model,

      ...verification
    };

  } catch (error) {

    return {

      ok: false,

      model,

      error:
        "Gemini returned invalid JSON.",

      rawModelText:
        text
    };
  }
}