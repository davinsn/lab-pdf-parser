import fs from "fs/promises";
import path from "path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
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
 * Normalize extracted PDF text.
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

    // Skip obvious scientific/table data.
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
 * Find the index of the first colon in a line that looks like
 * a genuine "Key: Value" separator, skipping colons that are
 * actually part of a time-of-day value (e.g. "3:59:56 PM"),
 * which have a digit immediately before AND after the colon.
 */
function findFieldColonIndex(line) {
  let searchFrom = 0;

  while (true) {
    const colonIndex = line.indexOf(":", searchFrom);

    if (colonIndex === -1) {
      return -1;
    }

    const before = line[colonIndex - 1];
    const after = line[colonIndex + 1];

    const isTimeLike =
      before !== undefined &&
      after !== undefined &&
      /\d/.test(before) &&
      /\d/.test(after);

    if (!isTimeLike) {
      return colonIndex;
    }

    searchFrom = colonIndex + 1;
  }
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
 * text remains a text block.
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
 * Extract text from PDF.js pages.
 *
 * This is the important part for table extraction.
 *
 * Unlike pdf-parse's flattened text output,
 * this preserves:
 *
 * - x position
 * - y position
 * - width
 * - height
 * - individual text items
 */
async function extractPages(pdfDocument) {
  const pages = [];

  for (
    let pageNumber = 1;
    pageNumber <= pdfDocument.numPages;
    pageNumber++
  ) {
    const page =
      await pdfDocument.getPage(pageNumber);

    const textContent =
      await page.getTextContent();

    const viewport =
      page.getViewport({
        scale: 1
      });

    const items =
      textContent.items
        .filter(
          (item) =>
            typeof item.str === "string" &&
            item.str.trim().length > 0
        )
        .map((item) => ({
          text: item.str,
          x: item.transform[4],
          y: item.transform[5],
          width: item.width ?? 0,
          height:
            item.height ??
            Math.abs(item.transform[3]) ??
            0,
          fontSize:
            Math.abs(item.transform[0]) || 0
        }));

    pages.push({
      pageNumber,
      width: viewport.width,
      height: viewport.height,
      items
    });
  }

  return pages;
}

/**
 * Group PDF.js text items into visual lines.
 *
 * Items with similar Y coordinates belong
 * to the same visual line.
 */
function groupItemsIntoLines(items) {
  const lines = [];

  const sortedItems =
    [...items].sort((a, b) => {
      if (Math.abs(a.y - b.y) > 2) {
        return b.y - a.y;
      }

      return a.x - b.x;
    });

  for (const item of sortedItems) {
    let line = lines.find(
      (candidate) =>
        Math.abs(candidate.y - item.y) <= 3
    );

    if (!line) {
      line = {
        y: item.y,
        items: []
      };

      lines.push(line);
    }

    line.items.push(item);
  }

  for (const line of lines) {
    line.items.sort(
      (a, b) => a.x - b.x
    );

    line.text =
      line.items
        .map((item) => item.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
  }

  return lines;
}

/**
 * Add grouped visual lines to every page.
 */
function buildPageLines(pages) {
  return pages.map((page) => ({
    ...page,
    lines: groupItemsIntoLines(page.items)
  }));
}

/**
 * Remove table lines from normal paragraph extraction.
 *
 * For now we leave raw text untouched because
 * tableExtractor works from positional page data.
 */
function removeTableLines(rawText, tables) {
  const lines = getLines(rawText);

  if (
    !tables ||
    Object.keys(tables).length === 0
  ) {
    return rawText;
  }

  /*
   * Do not remove arbitrary lines.
   *
   * The table extractor uses positional data,
   * while rawText has already lost layout information.
   *
   * Keeping rawText intact prevents normal text
   * from accidentally being deleted.
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

  let pdfDocument = null;

  try {
    /*
     * --------------------------------------------------
     * 1. LOAD PDF WITH PDF.JS
     * --------------------------------------------------
     */

    pdfDocument =
      await getDocument({
        data: new Uint8Array(buffer)
      }).promise;

    /*
     * --------------------------------------------------
     * 2. EXTRACT POSITIONAL PAGE DATA
     * --------------------------------------------------
     */

    const pages =
      await extractPages(pdfDocument);

    const pagesWithLines =
      buildPageLines(pages);

    /*
     * --------------------------------------------------
     * 3. BUILD RAW TEXT
     * --------------------------------------------------
     */

    const extractedText =
      pagesWithLines
        .map((page) => {
          return page.lines
            .map((line) => line.text)
            .join("\n");
        })
        .join("\n\n");

    const rawText =
      normalizeText(extractedText);

    /*
     * --------------------------------------------------
     * 4. PDF METADATA
     * --------------------------------------------------
     */

    let info = null;

    try {
      const metadata =
        await pdfDocument.getMetadata();

      info =
        metadata?.info ??
        null;
    } catch (error) {
      console.warn(
        "Warning: PDF metadata could not be extracted."
      );
    }

    /*
     * --------------------------------------------------
     * 5. DETERMINISTIC DOCUMENT EXTRACTION
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
     * 6. TABLE EXTRACTION
     * --------------------------------------------------
     *
     * IMPORTANT:
     *
     * Pass pagesWithLines, NOT rawText.
     *
     * This allows tableExtractor.js to use
     * X/Y coordinates.
     */

    const tables =
      extractTables(pagesWithLines);

    /*
     * --------------------------------------------------
     * 7. PARAGRAPHS
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
     * 8. STATISTICS
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
     * 9. FINAL STRUCTURED RESULT
     * --------------------------------------------------
     */

    return {
      source: {
        filePath: absolutePath,
        fileName: path.basename(
          absolutePath
        ),
        byteSize: buffer.length
      },

      metadata: {
        pageCount:
          pdfDocument.numPages,

        info,

        version:
          info?.PDFFormatVersion ??
          null
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
        parser: "pdfjs-dist",

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
     * PDF.js cleanup.
     */

    if (pdfDocument) {
      try {
        await pdfDocument.cleanup();
      } catch {
        // Ignore cleanup errors.
      }

      try {
        await pdfDocument.destroy();
      } catch {
        // Ignore destroy errors.
      }
    }
  }
}

export default {
  extractPdf
};