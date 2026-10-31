/** Pure helpers for the admin "jump to page" palette (kept free of JSX so they are unit-testable). */
export interface NavSearchItem {
  id: string;
  label: string;
  group: string;
  description: string;
  keywords?: string[];
}

/** Ranks items: label starts-with > label contains > group/description/keyword match. Empty query keeps order. */
export function filterNavItems<T extends NavSearchItem>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const terms = q.split(/\s+/);
  const scored: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const label = item.label.toLowerCase();
    const hay = [item.label, item.group, item.description, ...(item.keywords || [])].join(" ").toLowerCase();
    if (!terms.every((t) => hay.includes(t))) return;
    let score = 1;
    if (label.startsWith(q)) score = 4;
    else if (label.includes(q)) score = 3;
    else if (terms.every((t) => label.includes(t))) score = 2;
    scored.push({ item, score, index });
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((s) => s.item);
}
