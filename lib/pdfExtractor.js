import fs from "fs/promises";
import { PDFParse } from "pdf-parse";

/**
 * ============================================================
 * Generic deterministic entity patterns
 * ============================================================
 *
 * These are intentionally domain-agnostic.
 * Gemini will verify these results later.
 */

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
 * ============================================================
 * Normalize PDF text
 * ============================================================
 */

function normalizeText(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")

    // Remove non-printable control characters
    .replace(
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
      ""
    )

    // Remove PDF page markers
    .replace(/--\s*\d+\s+of\s+\d+\s*--/gi, "")

    // Join words broken across lines
    // "docu-\nment" -> "document"
    .replace(/(\w)-\n(\w)/g, "$1$2")

    // Normalize tabs
    .replace(/\t+/g, " ")

    // Remove trailing whitespace
    .replace(/[ \t]+\n/g, "\n")

    // Remove leading whitespace
    .replace(/\n[ \t]+/g, "\n")

    // Collapse repeated spaces
    .replace(/[ \t]{2,}/g, " ")

    // Collapse excessive blank lines
    .replace(/\n{3,}/g, "\n\n")

    .trim();
}


/**
 * ============================================================
 * Split text into lines
 * ============================================================
 */

function getLines(rawText) {
  return rawText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}


/**
 * ============================================================
 * Detect document title
 * ============================================================
 *
 * Generic heuristic:
 * - Usually one of the first few meaningful lines
 * - Relatively short
 * - Contains letters
 * - Not obviously a data row
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
 * ============================================================
 * Detect headings
 * ============================================================
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

    // Sentences are unlikely to be headings
    if (/[.,;:]$/.test(line)) {
      continue;
    }

    // Ignore obvious numbered data
    if (/^\d+[\s.]*/.test(line)) {
      continue;
    }

    const numbers = line.match(/\d/g) || [];
    const numberRatio =
      numbers.length / line.length;

    if (numberRatio > 0.25) {
      continue;
    }

    const words = line.split(/\s+/);

    if (words.length > 10) {
      continue;
    }

    // Obvious measurement/data rows
    if (
      /\b(?:ppm|cps|LOD|BEC|RSD|SD|Mean|Coeff|Correlation|Concentration)\b/i
        .test(line)
    ) {
      continue;
    }

    const isAllCaps =
      line === line.toUpperCase() &&
      /[A-Z]/.test(line);

    const titleCaseWords = words.filter((word) =>
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
 * ============================================================
 * Extract generic key/value fields
 * ============================================================
 *
 * Examples:
 *
 * Product: Sodium Chloride
 * Batch No: NC-2026-08841
 * Analyst: J. Tan
 *
 * This does NOT know what "Product" or "Batch No" means.
 * It simply detects the generic "key: value" structure.
 */

function extractFields(rawText) {
  const fields = {};

  const lines = getLines(rawText);

  for (const line of lines) {

    const match = line.match(
      /^([^:]{2,80}):\s*(.+)$/
    );

    if (!match) {
      continue;
    }

    const key = match[1].trim();
    const value = match[2].trim();

    if (!key || !value) {
      continue;
    }

    // Avoid treating URLs as fields
    if (/^https?$/i.test(key)) {
      continue;
    }

    fields[key] = value;
  }

  return fields;
}


/**
 * ============================================================
 * Detect table-like blocks
 * ============================================================
 *
 * This is intentionally generic.
 *
 * It looks for consecutive lines that appear to contain
 * multiple columns separated by spaces.
 *
 * This is a first-pass table detector.
 *
 * Later we can replace/enhance this using pdf-parse's
 * layout/table functionality.
 */

function detectTables(rawText) {
  const lines = getLines(rawText);

  const tables = [];
  let currentTable = [];

  function flushTable() {
    if (currentTable.length >= 2) {
      tables.push(
        buildTable(currentTable)
      );
    }

    currentTable = [];
  }

  for (const line of lines) {

    const parts =
      line.split(/\s{2,}/)
        .map((part) => part.trim())
        .filter(Boolean);

    /*
     * A line with multiple separated values is
     * potentially part of a table.
     */
    if (parts.length >= 2) {
      currentTable.push({
        original: line,
        cells: parts
      });
    } else {
      flushTable();
    }
  }

  flushTable();

  return tables;
}


/**
 * ============================================================
 * Build generic table structure
 * ============================================================
 */

function buildTable(rows) {

  const columnCount =
    Math.max(
      ...rows.map((row) => row.cells.length)
    );

  const normalizedRows =
    rows.map((row) => {

      const cells = [...row.cells];

      while (cells.length < columnCount) {
        cells.push(null);
      }

      return cells;
    });

  return {
    type: "table",

    columnCount,

    rows: normalizedRows,

    rowCount: normalizedRows.length
  };
}


/**
 * ============================================================
 * Extract generic entities
 * ============================================================
 */

function extractEntities(rawText) {
  const entities = {};

  for (const [name, regex] of Object.entries(PATTERNS)) {

    // Reset regex state because some regexes are global.
    regex.lastIndex = 0;

    const matches = [
      ...rawText.matchAll(regex)
    ].map((match) =>
      match[0].trim()
    );

    const uniqueMatches = [
      ...new Set(matches)
    ];

    if (uniqueMatches.length > 0) {
      entities[name] = uniqueMatches;
    }
  }

  return entities;
}


/**
 * ============================================================
 * Build generic document blocks
 * ============================================================
 *
 * This gives us a more structured representation of the
 * document while keeping the original text available.
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
 * ============================================================
 * Extract PDF
 * ============================================================
 *
 * Gemini is NOT used here.
 *
 * This function only performs deterministic extraction.
 */

export async function extractPdf(filePath) {

  const buffer =
    await fs.readFile(filePath);

  const parser =
    new PDFParse({
      data: buffer
    });

  try {

    /**
     * --------------------------------------------------------
     * PDF text
     * --------------------------------------------------------
     */

    const textResult =
      await parser.getText();

    const extractedText =
      textResult?.text || "";

    const rawText =
      normalizeText(extractedText);


    /**
     * --------------------------------------------------------
     * PDF metadata
     * --------------------------------------------------------
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


    /**
     * --------------------------------------------------------
     * Generic document analysis
     * --------------------------------------------------------
     */

    const title =
      detectTitle(rawText);

    const headings =
      detectHeadings(rawText);

    const fields =
      extractFields(rawText);

    const tables =
      detectTables(rawText);

    const entities =
      extractEntities(rawText);

    const blocks =
      buildBlocks(rawText);


    /**
     * --------------------------------------------------------
     * Paragraphs
     * --------------------------------------------------------
     */

    const paragraphs =
      rawText
        .split(/\n\s*\n+/)
        .map((paragraph) =>
          paragraph
            .replace(/[ \t]+/g, " ")
            .replace(/\n+/g, " ")
            .trim()
        )
        .filter(Boolean);


    /**
     * --------------------------------------------------------
     * Return structured document
     * --------------------------------------------------------
     */

    return {

      source: {
        filePath,
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

        lineCount:
          getLines(rawText).length,

        tableCount:
          tables.length,

        fieldCount:
          Object.keys(fields).length,

        headingCount:
          headings.length
      },

      /**
       * Keep the original normalized text.
       *
       * This is important because:
       * - Gemini needs it for verification
       * - debugging needs it
       * - future extractors can use it
       */
      rawText,

      extractedAt:
        new Date().toISOString()
    };

  } finally {

    await parser.destroy();

  }
}