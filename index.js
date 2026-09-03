#!/usr/bin/env node

import path from "path";
import fs from "fs/promises";
import dotenv from "dotenv";

import { extractPdf } from "./lib/pdfExtractor.js";
import { verifyWithGemini } from "./lib/geminiVerifier.js";

dotenv.config();

/**
 * ============================================================
 * Parse command-line arguments
 * ============================================================
 */
function parseArgs(argv) {
  const args = {
    verify: false,
    out: null,
    force: false,
    input: null
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === "--verify" || a === "-v") {
      args.verify = true;
    } else if (a === "--force" || a === "-f") {
      args.force = true;
    } else if (a === "--out" || a === "-o") {
      args.out = argv[++i];
      if (!args.out) {
        throw new Error("--out requires a path argument");
      }
    } else if (!args.input) {
      args.input = a;
    } else {
      // A second positional argument was given — fail loudly instead
      // of silently dropping it.
      throw new Error(
        `Unexpected extra argument: "${a}". Only one input PDF is supported per run.`
      );
    }
  }

  return args;
}

/**
 * ============================================================
 * Validate the input file exists and looks like a PDF
 * ============================================================
 */
async function validateInputFile(inputPath) {
  let stat;
  try {
    stat = await fs.stat(inputPath);
  } catch {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  if (!stat.isFile()) {
    throw new Error(`Input path is not a file: ${inputPath}`);
  }

  if (path.extname(inputPath).toLowerCase() !== ".pdf") {
    console.warn(
      `Warning: "${inputPath}" does not have a .pdf extension. Continuing anyway.`
    );
  }
}

/**
 * ============================================================
 * Main
 * ============================================================
 */
async function main() {
  const argv = process.argv.slice(2);

  const {
    input,
    verify,
    out,
    force
  } = parseArgs(argv);

  /**
   * ----------------------------------------------------------
   * Validate input
   * ----------------------------------------------------------
   */
  if (!input) {
    console.error(
      "Usage: node index.js <path-to-pdf> [--out output.json] [--verify] [--force]\n\n" +
      "  --verify    Run the extracted data through Gemini for verification\n" +
      "              (requires GEMINI_API_KEY in .env)\n\n" +
      "  --out       Output JSON path\n" +
      "              (default: <input-name>.json next to the input file)\n\n" +
      "  --force     Overwrite the output file if it already exists"
    );

    process.exit(1);
  }

  /**
   * ----------------------------------------------------------
   * Resolve paths
   * ----------------------------------------------------------
   */
  const inputPath = path.resolve(input);

  const outputPath = out
    ? path.resolve(out)
    : inputPath.replace(/\.pdf$/i, "") + ".json";

  await validateInputFile(inputPath);

  /**
   * ----------------------------------------------------------
   * Guard against silently clobbering an existing output file
   * ----------------------------------------------------------
   */
  if (!force) {
    try {
      await fs.access(outputPath);
      console.error(
        `Output file already exists: ${outputPath}\n` +
        `Re-run with --force to overwrite, or use --out to choose a different path.`
      );
      process.exit(1);
    } catch {
      // File doesn't exist — safe to proceed.
    }
  }

  console.log(`Reading: ${inputPath}`);

  /**
   * ----------------------------------------------------------
   * Deterministic PDF extraction
   * ----------------------------------------------------------
   *
   * PDF.js is responsible for extracting:
   * - text
   * - page information
   * - positional information
   * - table structure
   *
   * Gemini is NOT used here.
   */
  const extraction = await extractPdf(inputPath);

  if (!extraction || typeof extraction !== "object") {
    throw new Error(
      "extractPdf() returned an unexpected result (expected an object)."
    );
  }

  /**
   * ----------------------------------------------------------
   * Display extraction summary
   * ----------------------------------------------------------
   * Defensive against shape changes in extractPdf's output —
   * missing fields degrade to 0 instead of throwing.
   */
  const pageCount =
    extraction.metadata?.pageCount ?? 0;

  const paragraphCount =
    extraction.document?.paragraphCount ?? 0;

  const headingCount =
    extraction.document?.headings?.length ?? 0;

  const fieldCount =
    extraction.document?.fields
      ? Object.keys(extraction.document.fields).length
      : 0;

  const tableCount =
    extraction.document?.tables
      ? Object.keys(extraction.document.tables).length
      : 0;

  const entityCount =
    extraction.entities
      ? Object.values(extraction.entities)
          .reduce(
            (total, values) =>
              total + (Array.isArray(values) ? values.length : 0),
            0
          )
      : 0;

  console.log(
    `Extracted ${pageCount} page(s), ` +
    `${paragraphCount} paragraph(s), ` +
    `${headingCount} heading(s), ` +
    `${fieldCount} field(s), ` +
    `${tableCount} table(s), ` +
    `${entityCount} entit${entityCount === 1 ? "y" : "ies"}.`
  );

  /**
   * ----------------------------------------------------------
   * Build final result
   * ----------------------------------------------------------
   */
  const result = {
    ...extraction
  };

  /**
   * ----------------------------------------------------------
   * Gemini verification
   * ----------------------------------------------------------
   *
   * Gemini is ONLY used after deterministic extraction.
   */
  if (verify) {
    const model =
      process.env.GEMINI_MODEL ||
      "gemini-3.6-flash";

    console.log(
      `Running Gemini verification (model: ${model})...`
    );

    try {
      const verification =
        await verifyWithGemini(extraction);

      result.verification =
        verification;

      if (verification.ok) {
        console.log(
          `Verification complete — ` +
          `verified=${verification.verified}, ` +
          `confidence=${verification.confidence}`
        );
      } else {
        console.log(
          "Verification returned an invalid or empty response."
        );
      }
    } catch (err) {
      console.error(
        `Verification failed: ${err.message}`
      );

      result.verification = {
        ok: false,
        error: err.message
      };
    }
  }

  /**
   * ----------------------------------------------------------
   * Write JSON output
   * ----------------------------------------------------------
   */
  await fs.writeFile(
    outputPath,
    JSON.stringify(result, null, 2),
    "utf-8"
  );

  console.log(
    `Wrote: ${outputPath}`
  );
}

/**
 * ============================================================
 * Error handling
 * ============================================================
 */
main().catch((err) => {
  console.error(
    "Fatal error:",
    err.message ?? err
  );

  process.exit(1);
});