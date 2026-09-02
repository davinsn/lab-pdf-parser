// lib/tableExtractor.js

/**
 * Generic deterministic table extraction.
 *
 * Handles two common PDF text layouts:
 *
 * 1. Horizontal rows:
 *
 *    Name       Age       Department
 *    John       25        Engineering
 *    Jane       31        Finance
 *
 * 2. Vertical cell extraction:
 *
 *    Name
 *    Age
 *    Department
 *
 *    John
 *    25
 *    Engineering
 *
 *    Jane
 *    31
 *    Finance
 *
 * The extractor does NOT know the domain of the PDF.
 */

function cleanLine(line) {
  return String(line ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function getLines(text) {
  return String(text ?? "")
    .split("\n")
    .map(cleanLine)
    .filter(Boolean);
}

/**
 * Split a line when there are obvious column gaps.
 *
 * Example:
 * "John        25        Engineering"
 *
 * becomes:
 * ["John", "25", "Engineering"]
 */
function splitHorizontalRow(line) {
  const cells = String(line)
    .split(/\s{2,}|\t+/)
    .map((cell) => cell.trim())
    .filter(Boolean);

  return cells;
}

/**
 * Detect whether a line looks like a plausible table header.
 *
 * We deliberately keep this generic.
 */
function looksLikeHeader(line) {
  const cells = splitHorizontalRow(line);

  if (cells.length >= 2) {
    return true;
  }

  return false;
}

/**
 * Determine whether a sequence of lines can represent
 * a vertical table.
 *
 * Example:
 *
 * Header:
 * A
 * B
 * C
 *
 * Row:
 * 1
 * 2
 * 3
 */
function detectVerticalTable(lines, startIndex) {
  if (startIndex >= lines.length) {
    return null;
  }

  const headerCount = Math.min(12, lines.length - startIndex);

  /*
   * We try possible header sizes from larger to smaller.
   * This is useful because a table might have 2, 3, 4, 5...
   * columns.
   */
  for (let columnCount = headerCount; columnCount >= 2; columnCount--) {
    const headers = lines.slice(
      startIndex,
      startIndex + columnCount
    );

    if (!isPlausibleHeader(headers)) {
      continue;
    }

    const dataStart = startIndex + columnCount;

    if (dataStart >= lines.length) {
      continue;
    }

    const remaining = lines.length - dataStart;

    /*
     * Need at least one complete row.
     */
    if (remaining < columnCount) {
      continue;
    }

    const possibleRowCount = Math.floor(
      remaining / columnCount
    );

    if (possibleRowCount < 1) {
      continue;
    }

    const rows = [];

    for (let rowIndex = 0; rowIndex < possibleRowCount; rowIndex++) {
      const rowStart =
        dataStart + rowIndex * columnCount;

      const rowCells = lines.slice(
        rowStart,
        rowStart + columnCount
      );

      if (rowCells.length !== columnCount) {
        break;
      }

      /*
       * Don't allow obvious document-level fields to
       * accidentally become table rows.
       */
      if (
        rowCells.some((cell) =>
          /^Overall Result\s*:/i.test(cell)
        )
      ) {
        break;
      }

      if (
        rowCells.some((cell) =>
          /^Tested by\s*:/i.test(cell)
        )
      ) {
        break;
      }

      rows.push(rowCells);
    }

    if (rows.length === 0) {
      continue;
    }

    return {
      startIndex,
      endIndex:
        dataStart + rows.length * columnCount - 1,
      headers,
      rows,
      columnCount
    };
  }

  return null;
}

function isPlausibleHeader(headers) {
  if (!headers || headers.length < 2) {
    return false;
  }

  const unique = new Set(
    headers.map((header) => header.toLowerCase())
  );

  if (unique.size !== headers.length) {
    return false;
  }

  for (const header of headers) {
    if (!header || header.length > 100) {
      return false;
    }

    /*
     * A header should generally contain letters.
     */
    if (!/[A-Za-z]/.test(header)) {
      return false;
    }
  }

  return true;
}

/**
 * Detect horizontal tables.
 *
 * This works when pdf-parse preserves enough spacing
 * between columns.
 */
function detectHorizontalTables(lines) {
  const tables = [];

  let currentRows = [];

  function flush() {
    if (currentRows.length >= 2) {
      const table = buildTableFromRows(currentRows);

      if (table) {
        tables.push(table);
      }
    }

    currentRows = [];
  }

  for (const line of lines) {
    const cells = splitHorizontalRow(line);

    if (cells.length >= 2) {
      currentRows.push(cells);
    } else {
      flush();
    }
  }

  flush();

  return tables;
}

/**
 * Build a structured table object.
 */
function buildTableFromRows(rows) {
  if (!rows || rows.length < 2) {
    return null;
  }

  const headers = rows[0];

  if (!isPlausibleHeader(headers)) {
    return null;
  }

  const structuredRows = {};

  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];

    /*
     * Rows with substantially fewer cells are probably not
     * part of this table.
     */
    if (cells.length < Math.ceil(headers.length * 0.6)) {
      continue;
    }

    const rowObject = {};

    for (let columnIndex = 0; columnIndex < headers.length; columnIndex++) {
      const header = headers[columnIndex];

      rowObject[header] =
        cells[columnIndex] !== undefined
          ? cells[columnIndex]
          : null;
    }

    structuredRows[`row_${Object.keys(structuredRows).length + 1}`] =
      rowObject;
  }

  if (Object.keys(structuredRows).length === 0) {
    return null;
  }

  return {
    headers,
    rows: structuredRows,
    rowCount: Object.keys(structuredRows).length,
    columnCount: headers.length
  };
}

/**
 * Detect vertically extracted tables.
 *
 * This is particularly useful for your current PDF output:
 *
 * Organism
 * Count
 * Unit
 * Acceptance Limit
 * Result
 *
 * Total Aerobic Plate Count
 * 180
 * CFU/g
 * ≤ 10,000
 * Pass
 *
 * etc.
 */
function detectVerticalTables(lines) {
  const tables = [];

  let index = 0;

  while (index < lines.length) {
    const candidate = detectVerticalTable(lines, index);

    if (!candidate) {
      index++;
      continue;
    }

    const table = {
      headers: candidate.headers,
      rows: {},
      rowCount: 0,
      columnCount: candidate.columnCount
    };

    candidate.rows.forEach((cells) => {
      const rowNumber =
        Object.keys(table.rows).length + 1;

      const rowObject = {};

      candidate.headers.forEach((header, columnIndex) => {
        rowObject[header] =
          cells[columnIndex] ?? null;
      });

      table.rows[`row_${rowNumber}`] = rowObject;
    });

    table.rowCount =
      Object.keys(table.rows).length;

    if (table.rowCount > 0) {
      tables.push({
        table,
        startIndex: candidate.startIndex,
        endIndex: candidate.endIndex
      });

      index = candidate.endIndex + 1;
    } else {
      index++;
    }
  }

  return tables;
}

/**
 * Remove tables that overlap the same section.
 */
function removeDuplicateTables(tables) {
  const result = [];

  for (const candidate of tables) {
    const duplicate = result.some((existing) => {
      if (
        existing.startIndex === undefined ||
        candidate.startIndex === undefined
      ) {
        return false;
      }

      return (
        candidate.startIndex >= existing.startIndex &&
        candidate.startIndex <= existing.endIndex
      );
    });

    if (!duplicate) {
      result.push(candidate);
    }
  }

  return result;
}

/**
 * Public API.
 *
 * Returns:
 *
 * {
 *   table_1: {
 *     headers: [...],
 *     rows: {
 *       row_1: {...},
 *       row_2: {...}
 *     },
 *     rowCount: 2,
 *     columnCount: 5
 *   }
 * }
 */
export function extractTables(rawText) {
  const lines = getLines(rawText);

  if (lines.length === 0) {
    return {};
  }

  /*
   * First attempt horizontal tables.
   */
  const horizontalTables =
    detectHorizontalTables(lines);

  /*
   * Then attempt vertical tables.
   */
  const verticalTables =
    detectVerticalTables(lines);

  const candidates = [
    ...horizontalTables.map((table) => ({
      table,
      startIndex: null,
      endIndex: null
    })),
    ...verticalTables
  ];

  const uniqueCandidates =
    removeDuplicateTables(candidates);

  const result = {};

  uniqueCandidates.forEach((candidate) => {
    const tableNumber =
      Object.keys(result).length + 1;

    result[`table_${tableNumber}`] =
      candidate.table;
  });

  return result;
}

export default {
  extractTables
};