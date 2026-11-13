// NBA injury-report PDF names with the suffix set off by its own comma ("Udeh, Jr., Ernest", 2026-10-31 to 11-11
// reports). The frozen engine/injury.js normalizeName swaps at the first comma only, so the leftover comma kept the
// player from matching ("Ernest Udeh Jr."). Joined here, on the parsed rows, before matching (2026-11-12 user decision:
// a new file outside the frozen paths, every 2023-24 to 2025-26 row byte-identical, fixes logged as pdfNameFixes).
const SUFFIX = /^([^,\s][^,]*), (Jr\.|Sr\.|II|III|IV|V), ([^,\s][^,]*)$/;

// "Last, Jr., First" -> "Last Jr., First"; any other name comes back unchanged
export const joinSuffixComma = name => (typeof name === 'string' ? name.replace(SUFFIX, '$1 $2, $3') : name);
