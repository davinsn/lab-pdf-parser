#!/usr/bin/env node
import path from "path";
import fs from "fs/promises";
import dotenv from "dotenv";
import { extractPdf } from "./lib/pdfExtractor.js";
import { verifyWithGemini } from "./lib/geminiVerifier.js";

dotenv.config();

function parseArgs(argv) {
  const args = { verify: false, out: null, input: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--verify" || a === "-v") args.verify = true;
    else if (a === "--out" || a === "-o") args.out = argv[++i];
    else if (!args.input) args.input = a;
  }
  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  const { input, verify, out } = parseArgs(argv);

  if (!input) {
    console.error(
      "Usage: node src/index.js <path-to-pdf> [--out output.json] [--verify]\n\n" +
        "  --verify   Run the extracted data through Gemini for a verification pass\n" +
        "             (requires GEMINI_API_KEY in .env)\n" +
        "  --out      Output JSON path (default: <input-name>.json next to the input file)"
    );
    process.exit(1);
  }

  const inputPath = path.resolve(input);
  const outputPath = out
    ? path.resolve(out)
    : inputPath.replace(/\.pdf$/i, "") + ".json";

  console.log(`Reading: ${inputPath}`);
  const extraction = await extractPdf(inputPath);
  console.log(
    `Extracted ${extraction.metadata.pageCount} page(s), ${extraction.content.paragraphCount} paragraph(s), ` +
      `${extraction.content.detectedHeadings.length} candidate heading(s).`
  );

  const result = { ...extraction };

  if (verify) {
    console.log(`Running Gemini verification (model: ${process.env.GEMINI_MODEL || "gemini-2.0-flash"})...`);
    try {
      const verification = await verifyWithGemini(extraction);
      result.verification = verification;
      console.log(
        verification.ok
          ? `Verification complete — verified=${verification.verified}, confidence=${verification.confidence}`
          : `Verification returned non-JSON output; stored raw model text under result.verification.rawModelText`
      );
    } catch (err) {
      console.error(`Verification failed: ${err.message}`);
      result.verification = { ok: false, error: err.message };
    }
  }

  await fs.writeFile(outputPath, JSON.stringify(result, null, 2), "utf-8");
  console.log(`Wrote: ${outputPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});