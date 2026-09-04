/**
 * ============================================================
 * POSITION-AWARE TABLE EXTRACTOR
 * ============================================================
 *
 * Designed for PDF.js positional output.
 *
 * Input:
 *
 * pages = [
 *   {
 *     pageNumber: 1,
 *     lines: [
 *       {
 *         y: 700,
 *         text: "...",
 *         items: [
 *           {
 *             text: "Reported",
 *             x: 50,
 *             width: 45
 *           },
 *           {
 *             text: "104",
 *             x: 180,
 *             width: 20
 *           },
 *           {
 *             text: "%",
 *             x: 202,
 *             width: 8
 *           }
 *         ]
 *       }
 *     ]
 *   }
 * ]
 *
 * The extractor uses X coordinates to reconstruct columns.
 *
 * Important:
 * - Do NOT pass rawText.
 * - Pass pagesWithLines from pdfExtractor.js.
 * ============================================================
 */

/**
 * ============================================================
 * CONSTANTS
 * ============================================================
 */

const POSITION_TOLERANCE = 8;
const MIN_COLUMN_OCCURRENCES = 2;
const MIN_TABLE_ROWS = 3;

const CELL_JOIN_GAP = 12;

const MIN_COLUMN_GAP = 20;

const MAX_COLUMN_COUNT = 40;

/**
 * ============================================================
 * CLEAN TEXT
 * ============================================================
 */

function cleanText(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * ============================================================
 * GET VALID POSITIONAL ITEMS
 * ============================================================
 */

function getLineItems(line) {
  if (!line?.items || !Array.isArray(line.items)) {
    return [];
  }

  return line.items
    .filter(
      (item) =>
        typeof item?.text === "string" &&
        item.text.trim().length > 0
    )
    .map((item) => ({
      text: cleanText(item.text),
      x: Number(item.x ?? 0),
      y: Number(item.y ?? line.y ?? 0),
      width: Number(item.width ?? 0),
      height: Number(item.height ?? 0),
      fontSize: Number(item.fontSize ?? 0)
    }))
    .sort((a, b) => a.x - b.x);
}

/**
 * ============================================================
 * GET GAP BETWEEN ITEMS
 * ============================================================
 */

function getGap(previous, current) {
  if (!previous || !current) {
    return 0;
  }

  return current.x - (previous.x + previous.width);
}

/**
 * ============================================================
 * MERGE ITEMS THAT BELONG TO THE SAME CELL
 * ============================================================
 *
 * Example:
 *
 *   104     %
 *   |       |
 *   x=180   x=202
 *
 * becomes:
 *
 *   "104 %"
 *
 * This prevents "%" from becoming its own column.
 * ============================================================
 */

function mergeCellItems(items) {
  if (items.length <= 1) {
    return items;
  }

  const merged = [];

  let current = {
    ...items[0]
  };

  for (let i = 1; i < items.length; i++) {
    const next = items[i];

    const gap = getGap(current, next);

    /**
     * Small gaps usually mean the PDF split one logical
     * cell into multiple text items.
     */
    if (gap <= CELL_JOIN_GAP) {
      current.text = `${current.text} ${next.text}`.trim();

      const end = Math.max(
        current.x + current.width,
        next.x + next.width
      );

      current.width = end - current.x;

      continue;
    }

    merged.push(current);

    current = {
      ...next
    };
  }

  merged.push(current);

  return merged;
}


function looksLikeFieldLine(line) {
  const text = cleanText(
    getLineItems(line)
      .map(item => item.text)
      .join(" ")
  );

  if (!text) {
    return false;
  }

  return /^[A-Za-z][A-Za-z0-9 _./()\-]{1,60}\s*:\s*.+$/.test(text);
}

/**
 * ============================================================
 * GET CANDIDATE TABLE LINES
 * ============================================================
 *
 * We don't simply look for large gaps anymore.
 *
 * Instead, we look for lines containing multiple positioned
 * items. Repeated X positions are identified later.
 * ============================================================
 */

function getCandidateLines(page) {
  if (!Array.isArray(page?.lines)) {
    return [];
  }

  return page.lines.filter((line) => {
    const items = getLineItems(line);

    if (items.length < 2) {
      return false;
    }

    if (looksLikeFieldLine(line)) {
      return false;
    }

    return true;
  });
}

/**
 * ============================================================
 * CLUSTER X POSITIONS
 * ============================================================
 *
 * PDF.js may produce tiny floating-point differences:
 *
 * 223.919998
 * 223.920001
 * 223.919997
 *
 * These are the same physical column.
 *
 * We therefore cluster positions within POSITION_TOLERANCE.
 * ============================================================
 */

function clusterPositions(positions) {
  if (!positions.length) {
    return [];
  }

  const sorted = [...positions]
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const clusters = [];

  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const value = sorted[i];

    const average =
      current.reduce(
        (sum, number) => sum + number,
        0
      ) / current.length;

    if (
      Math.abs(value - average) <=
      POSITION_TOLERANCE
    ) {
      current.push(value);
    } else {
      clusters.push(current);
      current = [value];
    }
  }

  clusters.push(current);

  return clusters.map((cluster) => ({
    x:
      cluster.reduce(
        (sum, value) => sum + value,
        0
      ) / cluster.length,

    count: cluster.length,

    min: Math.min(...cluster),

    max: Math.max(...cluster)
  }));
}

/**
 * ============================================================
 * GET STABLE COLUMN POSITIONS
 * ============================================================
 *
 * This is the most important part.
 *
 * A real table column normally appears at approximately the
 * same X position across many rows.
 *
 * We therefore count how often each X position occurs.
 * ============================================================
 */

function getColumnPositions(lines) {
  const positions = [];

  for (const line of lines) {
    let items = getLineItems(line);

    /**
     * Merge things like:
     *
     * 104 + %
     *
     * before detecting columns.
     */
    items = mergeCellItems(items);

    for (const item of items) {
      positions.push(item.x);
    }
  }

  if (!positions.length) {
    return [];
  }

  const clusters = clusterPositions(positions);

  /**
   * Only keep positions that occur more than once.
   *
   * A one-off X position is much more likely to be ordinary
   * text than an actual table column.
   */
  let stable = clusters.filter(
    (cluster) =>
      cluster.count >= MIN_COLUMN_OCCURRENCES
  );

  /**
   * If there aren't enough repeated positions, fall back to
   * all clusters rather than returning nothing.
   */
  if (stable.length < 2) {
    return [];
  }

  /**
   * Remove columns that are unrealistically close together.
   *
   * This protects against "%" or small fragments becoming
   * separate columns.
   */
  const filtered = [];

  for (const cluster of stable) {
    if (!filtered.length) {
      filtered.push(cluster);
      continue;
    }

    const previous =
      filtered[filtered.length - 1];

    if (
      cluster.x - previous.x >=
      MIN_COLUMN_GAP
    ) {
      filtered.push(cluster);
    } else {
      /**
       * Keep the cluster that occurs more often.
       */
      if (cluster.count > previous.count) {
        filtered[filtered.length - 1] =
          cluster;
      }
    }
  }

  /**
   * Prevent pathological detection.
   */
  return filtered
    .slice(0, MAX_COLUMN_COUNT)
    .map((cluster) => cluster.x);
}

/**
 * ============================================================
 * FIND COLUMN INDEX
 * ============================================================
 */

function findColumnIndex(x, columnPositions) {
  if (!columnPositions.length) {
    return -1;
  }

  let closestIndex = -1;
  let closestDistance = Infinity;

  for (
    let i = 0;
    i < columnPositions.length;
    i++
  ) {
    const distance = Math.abs(
      columnPositions[i] - x
    );

    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = i;
    }
  }

  /**
   * Don't assign an item to a column if it is very far away.
   */
  if (
    closestDistance >
    POSITION_TOLERANCE * 2
  ) {
    return -1;
  }

  return closestIndex;
}

/**
 * ============================================================
 * BUILD COLUMN BANDS
 * ============================================================
 *
 * Instead of simply saying:
 *
 *   "closest X wins"
 *
 * we define a physical band around every column.
 *
 * This prevents an item belonging to column 2 from jumping
 * into column 3.
 * ============================================================
 */

function buildColumnBands(columnPositions) {
  if (!columnPositions.length) {
    return [];
  }

  const bands = [];

  for (
    let i = 0;
    i < columnPositions.length;
    i++
  ) {
    const current = columnPositions[i];

    const previous =
      i > 0
        ? columnPositions[i - 1]
        : null;

    const next =
      i < columnPositions.length - 1
        ? columnPositions[i + 1]
        : null;

    const left =
      previous !== null
        ? (previous + current) / 2
        : current - 30;

    const right =
      next !== null
        ? (current + next) / 2
        : current + 30;

    bands.push({
      index: i,
      x: current,
      left,
      right
    });
  }

  return bands;
}

/**
 * ============================================================
 * ASSIGN ITEM TO BAND
 * ============================================================
 */

function findBandForItem(item, bands) {
  if (!bands.length) {
    return -1;
  }

  /**
   * First try to determine whether the item's starting X
   * lies directly inside a column band.
   */
  for (const band of bands) {
    if (
      item.x >= band.left &&
      item.x < band.right
    ) {
      return band.index;
    }
  }

  /**
   * Otherwise use nearest column.
   */
  return findColumnIndex(
    item.x,
    bands.map((band) => band.x)
  );
}

/**
 * ============================================================
 * CONVERT LINE TO ROW
 * ============================================================
 */

function lineToRow(line, columnPositions) {
  const rawItems = getLineItems(line);

  if (!rawItems.length) {
    return [];
  }

  /**
   * Merge fragments such as:
   *
   * 104 + %
   *
   * before assigning them to columns.
   */
  const items = mergeCellItems(rawItems);

  const bands =
    buildColumnBands(columnPositions);

  const columns = Array(
    columnPositions.length
  ).fill(null);

  for (const item of items) {
    const columnIndex =
      findBandForItem(item, bands);

    if (
      columnIndex < 0 ||
      columnIndex >= columns.length
    ) {
      continue;
    }

    if (!columns[columnIndex]) {
      columns[columnIndex] =
        item.text;
    } else {
      /**
       * If multiple items land in the same column,
       * concatenate them rather than overwriting.
       */
      columns[columnIndex] =
        `${columns[columnIndex]} ${item.text}`
          .replace(/\s+/g, " ")
          .trim();
    }
  }

  return columns;
}

/**
 * ============================================================
 * REMOVE COMPLETELY EMPTY COLUMNS
 * ============================================================
 *
 * Sometimes the detected table has columns that are never
 * populated. Remove those before building the final table.
 * ============================================================
 */

function removeEmptyColumns(rows) {
  if (!rows.length) {
    return {
      rows,
      indexes: []
    };
  }

  const columnCount = Math.max(
    ...rows.map((row) => row.length)
  );

  const used = [];

  for (let column = 0; column < columnCount; column++) {
    const hasValue = rows.some(
      (row) =>
        row[column] !== null &&
        row[column] !== undefined &&
        String(row[column]).trim() !== ""
    );

    if (hasValue) {
      used.push(column);
    }
  }

  const cleanedRows = rows.map((row) =>
    used.map(
      (index) =>
        row[index] ?? null
    )
  );

  return {
    rows: cleanedRows,
    indexes: used
  };
}

/**
 * ============================================================
 * DETERMINE WHETHER ROW LOOKS LIKE HEADER
 * ============================================================
 */

function looksLikeHeader(row) {
  if (!Array.isArray(row)) {
    return false;
  }

  const nonEmpty = row.filter(
    (cell) =>
      cell !== null &&
      cell !== undefined &&
      String(cell).trim() !== ""
  );

  if (nonEmpty.length < 2) {
    return false;
  }

  /**
   * Headers generally contain alphabetic characters.
   */
  const letterCells =
    nonEmpty.filter((cell) =>
      /[A-Za-z]/.test(String(cell))
    );

  if (letterCells.length === 0) {
    return false;
  }

  /**
   * A row containing mostly measurements is unlikely to be
   * a header.
   */
  const numericCells =
    nonEmpty.filter((cell) =>
      /^[\d.,%<>=+\-]+$/.test(
        String(cell).trim()
      )
    );

  if (
    numericCells.length ===
    nonEmpty.length
  ) {
    return false;
  }

  return true;
}

/**
 * ============================================================
 * FIND HEADER
 * ============================================================
 *
 * Look farther than only the first 5 rows because scientific
 * tables frequently have multiple title/header rows.
 * ============================================================
 */

function findHeaderIndex(rows) {
  const limit = Math.min(
    rows.length,
    15
  );

  for (let i = 0; i < limit; i++) {
    if (looksLikeHeader(rows[i])) {
      return i;
    }
  }

  return -1;
}

/**
 * ============================================================
 * NORMALIZE HEADER NAMES
 * ============================================================
 */

function normalizeHeaderName(value, index) {
  let header =
    cleanText(value) ||
    `column_${index + 1}`;

  /**
   * Make headers safe JSON object keys.
   */
  header = header
    .replace(/[^\w\s%.-]/g, "")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!header) {
    header = `column_${index + 1}`;
  }

  return header;
}

/**
 * ============================================================
 * NORMALIZE HEADERS
 * ============================================================
 */

function normalizeHeaders(headers) {
  const used = new Set();

  return headers.map(
    (header, index) => {
      const base =
        normalizeHeaderName(
          header,
          index
        );

      let value = base;
      let counter = 2;

      while (used.has(value)) {
        value =
          `${base}_${counter}`;
        counter++;
      }

      used.add(value);

      return value;
    }
  );
}

/**
 * ============================================================
 * BUILD STRUCTURED TABLE
 * ============================================================
 */

function buildStructuredTable(rows) {
  if (
    !Array.isArray(rows) ||
    rows.length < MIN_TABLE_ROWS
  ) {
    return null;
  }

  const cleaned = removeEmptyColumns(
    rows
  );

  const normalizedRows =
    cleaned.rows;

  if (
    normalizedRows.length <
    MIN_TABLE_ROWS
  ) {
    return null;
  }

  const headerIndex =
    findHeaderIndex(
      normalizedRows
    );

  if (headerIndex < 0) {
    return null;
  }

  const rawHeaders =
    normalizedRows[headerIndex];

  const headers =
    normalizeHeaders(
      rawHeaders
    );

  const structuredRows = {};

  for (
    let i = headerIndex + 1;
    i < normalizedRows.length;
    i++
  ) {
    const row =
      normalizedRows[i];

    const nonEmpty =
      row.filter(
        (cell) =>
          cell !== null &&
          cell !== undefined &&
          String(cell).trim() !== ""
      );

    if (
      nonEmpty.length < 2
    ) {
      continue;
    }

    /**
     * Reject rows that are clearly unrelated.
     */
    const numericRatio =
      nonEmpty.filter((cell) =>
        /^[\d.,%<>=+\- ]+$/.test(
          String(cell)
        )
      ).length /
      nonEmpty.length;

    /**
     * Scientific tables can legitimately be highly numeric,
     * so we allow numeric rows as long as they have enough
     * populated columns.
     */
    const minimumCells =
      Math.max(
        2,
        Math.ceil(
          headers.length * 0.3
        )
      );

    if (
      nonEmpty.length <
      minimumCells
    ) {
      continue;
    }

    const rowObject = {};

    for (
      let columnIndex = 0;
      columnIndex < headers.length;
      columnIndex++
    ) {
      rowObject[
        headers[columnIndex]
      ] =
        row[columnIndex] ??
        null;
    }

    const rowNumber =
      Object.keys(
        structuredRows
      ).length + 1;

    structuredRows[
      `row_${rowNumber}`
    ] = rowObject;
  }

  if (
    Object.keys(
      structuredRows
    ).length === 0
  ) {
    return null;
  }

  return {
    headers,
    rows: structuredRows,

    rowCount:
      Object.keys(
        structuredRows
      ).length,

    columnCount:
      headers.length
  };
}

/**
 * ============================================================
 * DETECT TABLES ON PAGE
 * ============================================================
 */

function detectTablesOnPage(page) {
  const candidateLines =
    getCandidateLines(page);

  if (
    candidateLines.length <
    MIN_TABLE_ROWS
  ) {
    return [];
  }

  /**
   * Find stable X positions.
   */
  const columnPositions =
    getColumnPositions(
      candidateLines
    );

  if (
    columnPositions.length < 2
  ) {
    return [];
  }

  /**
   * Convert every candidate line into a positional row.
   */
  const rows =
    candidateLines.map(
      (line) =>
        lineToRow(
          line,
          columnPositions
        )
    );

  const table =
    buildStructuredTable(
      rows
    );

  if (!table) {
    return [];
  }

  return [
    {
      ...table,

      page:
        page.pageNumber,

      columnPositions,

      sourceRows:
        rows
    }
  ];
}

/**
 * ============================================================
 * PUBLIC API
 * ============================================================
 */

export function extractTables(
  pages
) {
  if (
    !Array.isArray(pages)
  ) {
    return {};
  }

  const result = {};

  let tableNumber = 1;

  for (const page of pages) {
    const tables =
      detectTablesOnPage(
        page
      );

    for (const table of tables) {
      result[
        `table_${tableNumber}`
      ] = table;

      tableNumber++;
    }
  }

  return result;
}

/**
 * ============================================================
 * DEFAULT EXPORT
 * ============================================================
 */

export default {
  extractTables
};