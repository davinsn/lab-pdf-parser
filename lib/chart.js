/**
 * Generic SVG chart builders. Operate on plain measurement records
 * { sample, analyte, value, unit } -- doesn't matter whether they came
 * from a known-format parser or the AI fallback, as long as they follow
 * lib/schema.js. Categorical x-axis (sample labels), not numeric, so it
 * works regardless of how samples are named.
 *
 * No external chart library / native deps -- just hand-written SVG so this
 * runs anywhere Node runs.
 */

const COLORS = [
  "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
  "#42d4f4", "#f032e6", "#bfef45", "#469990", "#9a6324",
  "#800000", "#808000",
];

function uniqueInOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function buildLineChart(measurements, { title, yLabel } = {}) {
  const samples = uniqueInOrder(measurements.map((m) => m.sample));
  const analytes = uniqueInOrder(measurements.map((m) => m.analyte));
  const unit = measurements[0] ? measurements[0].unit : "";

  const values = measurements.map((m) => m.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const pad = Math.max(1, (rawMax - rawMin) * 0.15);
  const yMin = Math.floor(rawMin - pad);
  const yMax = Math.ceil(rawMax + pad);

  const W = 900, H = 550;
  const margin = { top: 50, right: 230, bottom: 60, left: 60 };
  const plotW = W - margin.left - margin.right;
  const plotH = H - margin.top - margin.bottom;

  const xScale = (i) => margin.left + (plotW * i) / Math.max(1, samples.length - 1);
  const yScale = (val) => margin.top + plotH - (plotH * (val - yMin)) / (yMax - yMin || 1);

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="sans-serif">`;
  svg += `<rect width="${W}" height="${H}" fill="white"/>`;
  svg += `<text x="${W / 2}" y="24" text-anchor="middle" font-size="16" font-weight="bold">${escapeXml(title || "Measurements by Sample")}</text>`;

  svg += `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}" stroke="#333"/>`;
  svg += `<line x1="${margin.left}" y1="${margin.top + plotH}" x2="${margin.left + plotW}" y2="${margin.top + plotH}" stroke="#333"/>`;

  const steps = 6;
  for (let s = 0; s <= steps; s++) {
    const v = yMin + ((yMax - yMin) * s) / steps;
    const y = yScale(v);
    svg += `<line x1="${margin.left}" y1="${y}" x2="${margin.left + plotW}" y2="${y}" stroke="#eee"/>`;
    svg += `<text x="${margin.left - 8}" y="${y + 4}" text-anchor="end" font-size="10">${v.toFixed(1)}</text>`;
  }

  samples.forEach((sample, i) => {
    const x = xScale(i);
    svg += `<text x="${x}" y="${margin.top + plotH + 20}" text-anchor="middle" font-size="10">${escapeXml(truncateLabel(sample))}</text>`;
  });
  svg += `<text x="${margin.left + plotW / 2}" y="${H - 10}" text-anchor="middle" font-size="12">Sample</text>`;
  svg += `<text x="18" y="${margin.top + plotH / 2}" text-anchor="middle" font-size="12" transform="rotate(-90 18 ${margin.top + plotH / 2})">${escapeXml(yLabel || unit || "Value")}</text>`;

  analytes.forEach((analyte, ai) => {
    const color = COLORS[ai % COLORS.length];
    const pts = samples
      .map((sample, i) => {
        const rec = measurements.find((m) => m.analyte === analyte && m.sample === sample);
        return rec ? `${xScale(i)},${yScale(rec.value)}` : null;
      })
      .filter(Boolean);

    svg += `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2"/>`;
    samples.forEach((sample, i) => {
      const rec = measurements.find((m) => m.analyte === analyte && m.sample === sample);
      if (rec) svg += `<circle cx="${xScale(i)}" cy="${yScale(rec.value)}" r="3.5" fill="${color}"/>`;
    });

    const legendY = margin.top + ai * 18;
    svg += `<line x1="${margin.left + plotW + 20}" y1="${legendY}" x2="${margin.left + plotW + 40}" y2="${legendY}" stroke="${color}" stroke-width="2"/>`;
    svg += `<text x="${margin.left + plotW + 45}" y="${legendY + 4}" font-size="11">${escapeXml(truncateLabel(analyte, 24))}</text>`;
  });

  svg += `</svg>`;
  return svg;
}

function buildHeatmap(measurements, { title } = {}) {
  const samples = uniqueInOrder(measurements.map((m) => m.sample));
  const analytes = uniqueInOrder(measurements.map((m) => m.analyte));

  const values = measurements.map((m) => m.value);
  const vMin = Math.min(...values);
  const vMax = Math.max(...values);
  const mid = (vMin + vMax) / 2;
  const range = Math.max(1e-9, vMax - vMin);

  function colorFor(val) {
    const dist = Math.min(1, Math.abs(val - mid) / (range / 2 || 1));
    const r = Math.round(255 * dist + 60 * (1 - dist));
    const g = Math.round(200 * (1 - dist) + 60 * dist);
    return `rgb(${r},${g},80)`;
  }

  const cellW = 100, cellH = 30;
  const margin = { top: 60, left: 150, right: 20, bottom: 20 };
  const W = margin.left + cellW * samples.length + margin.right;
  const H = margin.top + cellH * analytes.length + margin.bottom;

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="sans-serif">`;
  svg += `<rect width="${W}" height="${H}" fill="white"/>`;
  svg += `<text x="${W / 2}" y="22" text-anchor="middle" font-size="15" font-weight="bold">${escapeXml(title || "Measurement Heatmap")}</text>`;

  samples.forEach((sample, si) => {
    const x = margin.left + si * cellW;
    svg += `<text x="${x + cellW / 2}" y="${margin.top - 10}" text-anchor="middle" font-size="10">${escapeXml(truncateLabel(sample, 16))}</text>`;
  });

  analytes.forEach((analyte, ai) => {
    const y = margin.top + ai * cellH;
    svg += `<text x="${margin.left - 8}" y="${y + cellH / 2 + 4}" text-anchor="end" font-size="11">${escapeXml(truncateLabel(analyte, 20))}</text>`;
    samples.forEach((sample, si) => {
      const x = margin.left + si * cellW;
      const rec = measurements.find((m) => m.analyte === analyte && m.sample === sample);
      const fill = rec ? colorFor(rec.value) : "#eee";
      svg += `<rect x="${x}" y="${y}" width="${cellW - 2}" height="${cellH - 2}" fill="${fill}" />`;
      if (rec) {
        svg += `<text x="${x + cellW / 2}" y="${y + cellH / 2 + 4}" text-anchor="middle" font-size="10">${rec.value.toFixed(1)}</text>`;
      }
    });
  });

  svg += `</svg>`;
  return svg;
}

function truncateLabel(s, max = 14) {
  s = String(s);
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}

function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

module.exports = { buildLineChart, buildHeatmap };
