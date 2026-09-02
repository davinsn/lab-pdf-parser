function toCsv(measurements) {
  const header = "sample,analyte,value,unit,measurement_type";
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const rows = measurements.map(
    (m) => `${esc(m.sample)},${esc(m.analyte)},${m.value},${esc(m.unit || "")},${esc(m.measurementType || "")}`
  );
  return [header, ...rows].join("\n");
}

module.exports = { toCsv };
