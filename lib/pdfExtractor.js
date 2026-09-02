import fs from "fs/promises";
import path from "path";
import { PDFParse } from "pdf-parse";

import { extractTables } from "./tableExtractor.js";

const PATTERNS = {
  email:
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,

  url:
    /\bhttps?:\/\/[^\s)]+/g,

  date:
    /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}[-\s](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[-\s]\d{4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b/gi,

  currency:
    /(?:[$€£¥]\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|MYR))\b/gi,

  phone:
    /(?<![\d.])(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-])\d{3,4}[\s.-]\d{3,4}(?![\d.])/g,

  percentage:
    /\b\d+(?:\.\d+)?%/g
};

/**
 * Normalize raw PDF text.
 */
function normalizeText(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")

    // Remove control characters.
    .replace(
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
      ""
    )

    // Remove common PDF page markers.
    .replace(
      /--\s*\d+\s+of\s+\d+\s*--/gi,
      ""
    )

    // Join words broken across lines:
    // "microbio-\nlogy" -> "microbiology"
    .replace(
      /(\w)-\n(\w)/g,
      "$1$2"
    )

    // Convert tabs into spaces.
    .replace(/\t+/g, "    ")

    // Remove trailing whitespace.
    .replace(/[ \t]+\n/g, "\n")

    // Remove indentation introduced by PDF extraction.
    .replace(/\n[ \t]+/g, "\n")

    // Prevent huge blank-line runs.
    .replace(/\n{3,}/g, "\n\n")

    .trim();
}

/**
 * Convert raw text into clean lines.
 */
function getLines(rawText) {
  return String(rawText ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Detect a likely document title.
 */
function detectTitle(rawText) {
  const lines = getLines(rawText);

  for (const line of lines.slice(0, 10)) {
    if (line.length < 3 || line.length > 120) {
      continue;
    }

    if (!/[A-Za-z]/.test(line)) {
      continue;
    }

    const words = line.split(/\s+/);

    if (words.length > 15) {
      continue;
    }

    const numberCount =
      (line.match(/\d/g) || []).length;

    const numberRatio =
      numberCount / line.length;

    if (numberRatio > 0.25) {
      continue;
    }

    return line;
  }

  return null;
}

/**
 * Detect likely headings.
 */
function detectHeadings(rawText) {
  const lines = getLines(rawText);
  const headings = [];

  for (const line of lines) {
    if (line.length < 3 || line.length > 80) {
      continue;
    }

    if (!/[A-Za-z]/.test(line)) {
      continue;
    }

    if (/[.,;:]$/.test(line)) {
      continue;
    }

    if (/^\d+[\s.]*/.test(line)) {
      continue;
    }

    const numbers =
      line.match(/\d/g) || [];

    const numberRatio =
      numbers.length / line.length;

    if (numberRatio > 0.25) {
      continue;
    }

    const words =
      line.split(/\s+/);

    if (words.length > 10) {
      continue;
    }

    /*
     * Skip obvious scientific/table data.
     */
    if (
      /\b(?:ppm|cps|LOD|BEC|RSD|SD|Mean|Coeff|Correlation|Concentration)\b/i.test(
        line
      )
    ) {
      continue;
    }

    const isAllCaps =
      line === line.toUpperCase() &&
      /[A-Z]/.test(line);

    const titleCaseWords =
      words.filter((word) =>
        /^[A-Z][a-zA-Z-]*$/.test(word)
      ).length;

    const titleCaseRatio =
      titleCaseWords / words.length;

    const isTitleCase =
      titleCaseRatio >= 0.6;

    if (isAllCaps || isTitleCase) {
      headings.push(line);
    }
  }

  return [...new Set(headings)];
}

/**
 * Extract conventional:
 *
 * Key: Value
 *
 * fields.
 */
function extractFields(rawText) {
  const fields = {};
  const lines = getLines(rawText);

  for (const line of lines) {
    const match =
      line.match(/^([^:]{2,80}):\s*(.+)$/);

    if (!match) {
      continue;
    }

    const key = match[1].trim();
    const value = match[2].trim();

    if (!key || !value) {
      continue;
    }

    if (/^https?$/i.test(key)) {
      continue;
    }

    fields[key] = value;
  }

  return fields;
}

/**
 * Extract emails, URLs, dates, currencies,
 * phone numbers and percentages.
 */
function extractEntities(rawText) {
  const entities = {};

  for (const [name, regex] of Object.entries(PATTERNS)) {
    regex.lastIndex = 0;

    const matches = [
      ...rawText.matchAll(regex)
    ].map((match) =>
      match[0].trim()
    );

    const uniqueMatches =
      [...new Set(matches)];

    if (uniqueMatches.length > 0) {
      entities[name] = uniqueMatches;
    }
  }

  return entities;
}

/**
 * Build block-level representation.
 *
 * Fields remain identifiable while normal
 * text remains as a text block.
 */
function buildBlocks(rawText) {
  const lines = getLines(rawText);

  return lines.map((line, index) => {
    const fieldMatch =
      line.match(/^([^:]{2,80}):\s*(.+)$/);

    if (fieldMatch) {
      return {
        index,
        type: "field",
        text: line,
        key: fieldMatch[1].trim(),
        value: fieldMatch[2].trim()
      };
    }

    return {
      index,
      type: "text",
      text: line
    };
  });
}

/**
 * Extract paragraphs.
 */
function extractParagraphs(rawText) {
  return String(rawText ?? "")
    .split(/\n\s*\n+/)
    .map((paragraph) =>
      paragraph
        .replace(/[ \t]+/g, " ")
        .replace(/\n+/g, " ")
        .trim()
    )
    .filter(Boolean);
}

/**
 * Remove text belonging to obvious table regions
 * when building normal paragraphs.
 *
 * This prevents table rows from being treated as
 * ordinary paragraphs.
 */
function removeTableLines(rawText, tables) {
  const lines = getLines(rawText);

  if (!tables || Object.keys(tables).length === 0) {
    return rawText;
  }

  /*
   * We deliberately don't remove arbitrary lines here.
   *
   * Why?
   *
   * The text-only extractor does not have enough layout
   * information to safely know which exact lines belong
   * to a table after pdf-parse has flattened them.
   *
   * Therefore rawText remains untouched.
   */
  return lines.join("\n");
}

/**
 * Extract the PDF.
 */
export async function extractPdf(filePath) {
  const absolutePath =
    path.resolve(filePath);

  const buffer =
    await fs.readFile(absolutePath);

  const parser =
    new PDFParse({
      data: buffer
    });

  try {
    /*
     * --------------------------------------------------
     * 1. TEXT EXTRACTION
     * --------------------------------------------------
     */

    const textResult =
      await parser.getText();

    const extractedText =
      textResult?.text || "";

    const rawText =
      normalizeText(extractedText);

    /*
     * --------------------------------------------------
     * 2. PDF METADATA
     * --------------------------------------------------
     */

    let info = null;

    try {
      const infoResult =
        await parser.getInfo();

      info =
        infoResult?.info ??
        infoResult ??
        null;
    } catch (error) {
      console.warn(
        "Warning: PDF metadata could not be extracted."
      );
    }

    /*
     * --------------------------------------------------
     * 3. DETERMINISTIC DOCUMENT EXTRACTION
     * --------------------------------------------------
     */

    const title =
      detectTitle(rawText);

    const headings =
      detectHeadings(rawText);

    const fields =
      extractFields(rawText);

    const entities =
      extractEntities(rawText);

    const blocks =
      buildBlocks(rawText);

    /*
     * --------------------------------------------------
     * 4. TABLE EXTRACTION
     * --------------------------------------------------
     */

    const tables =
      extractTables(rawText);

    /*
     * --------------------------------------------------
     * 5. PARAGRAPHS
     * --------------------------------------------------
     */

    const paragraphText =
      removeTableLines(
        rawText,
        tables
      );

    const paragraphs =
      extractParagraphs(
        paragraphText
      );

    /*
     * --------------------------------------------------
     * 6. STATISTICS
     * --------------------------------------------------
     */

    const lineCount =
      getLines(rawText).length;

    const fieldCount =
      Object.keys(fields).length;

    const headingCount =
      headings.length;

    const tableCount =
      Object.keys(tables).length;

    const entityCount =
      Object.values(entities).reduce(
        (total, values) =>
          total + values.length,
        0
      );

    /*
     * --------------------------------------------------
     * 7. FINAL STRUCTURED RESULT
     * --------------------------------------------------
     */

    return {
      source: {
        filePath: absolutePath,
        fileName: path.basename(absolutePath),
        byteSize: buffer.length
      },

      metadata: {
        pageCount:
          textResult?.total ?? null,

        info,

        version:
          info?.PDFFormatVersion ?? null
      },

      document: {
        title,

        fields,

        headings,

        blocks,

        paragraphs,

        paragraphCount:
          paragraphs.length,

        tables
      },

      entities,

      extraction: {
        method: "deterministic",

        parser: "pdf-parse",

        hasText:
          rawText.length > 0,

        characterCount:
          rawText.length,

        lineCount,

        tableCount,

        fieldCount,

        headingCount,

        entityCount
      },

      rawText,

      extractedAt:
        new Date().toISOString()
    };
  } finally {
    /*
     * pdf-parse creates internal resources.
     * Always destroy the parser.
     */
    await parser.destroy();
  }
}

export default {
  extractPdf
};