import fs from "fs/promises";
import { PDFParse } from "pdf-parse";

/**
 * Lightweight entity extraction patterns.
 *
 * These are deterministic heuristics.
 * Gemini will verify the results later.
 */
const PATTERNS = {
  email:
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,

  url:
    /\bhttps?:\/\/[^\s)]+/g,

  date:
    /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b/gi,

  currency:
    /(?:[$€£¥]\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|MYR))\b/gi,

  phone:
    /\b(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?)?\d{3,4}[-.\s]?\d{3,4}\b/g,

  percentage:
    /\b\d+(?:\.\d+)?%/g
};

/**
 * Split extracted text into paragraph-like chunks.
 */
function splitIntoParagraphs(rawText) {
  return rawText
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
}

/**
 * Detect likely headings using simple deterministic heuristics.
 *
 * These are only candidates.
 * They are NOT guaranteed to be headings.
 */
function detectHeadings(rawText) {
  const lines = rawText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const headings = [];

  for (const line of lines) {
    if (line.length === 0 || line.length > 80) {
      continue;
    }

    if (!/[A-Za-z]/.test(line)) {
      continue;
    }

    // Don't treat normal sentences as headings.
    if (/[.,;:]$/.test(line)) {
      continue;
    }

    const words = line.split(/\s+/);

    if (words.length > 12) {
      continue;
    }

    const capitalizedRatio =
      words.filter((word) => /^[A-Z0-9]/.test(word)).length /
      words.length;

    const isAllCaps =
      line === line.toUpperCase();

    const isTitleCase =
      capitalizedRatio >= 0.6;

    if (isAllCaps || isTitleCase) {
      headings.push(line);
    }
  }

  return [...new Set(headings)];
}

/**
 * Extract deterministic entities from raw text.
 */
function extractEntities(rawText) {
  const entities = {};

  for (const [name, regex] of Object.entries(PATTERNS)) {
    const matches = [
      ...rawText.matchAll(regex)
    ].map((match) => match[0].trim());

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
 * Extract text and metadata from a PDF using pdf-parse.
 *
 * Gemini is NOT used here.
 *
 * @param {string} filePath
 * @returns {Promise<object>}
 */
export async function extractPdf(filePath) {
  const buffer = await fs.readFile(filePath);

  const parser = new PDFParse({
    data: buffer
  });

  try {
    const textResult = await parser.getText();

    const rawText =
      textResult?.text?.trim() || "";

    let info = null;

    try {
      const infoResult = await parser.getInfo();

      info =
        infoResult?.info ??
        infoResult ??
        null;
    } catch (error) {
      console.warn(
        "Warning: PDF metadata could not be extracted."
      );
    }

    const pageCount =
      textResult?.total ??
      null;

    const paragraphs =
      splitIntoParagraphs(rawText);

    const headings =
      detectHeadings(rawText);

    const entities =
      extractEntities(rawText);

    return {
      source: {
        filePath,
        byteSize: buffer.length
      },

      metadata: {
        pageCount,
        info,
        version:
          info?.PDFFormatVersion ??
          null
      },

      content: {
        rawText,
        paragraphs,
        paragraphCount: paragraphs.length,
        detectedHeadings: headings
      },

      entities,

      extractedAt:
        new Date().toISOString()
    };
  } finally {
    await parser.destroy();
  }
}