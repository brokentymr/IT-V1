/**
 * Bounded text extraction from filing HTML (Phase 4). Filings are large and messy; we never feed a
 * whole 10-K to the LLM. These helpers crudely strip markup and slice the two sections Engine 2
 * cares about: the concentration/relationship language (link enrichment) and the MD&A (driver
 * extraction). Both return a bounded char budget so the LLM call stays cheap.
 */
function htmlToText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
}

const CONCENTRATION_RE = /(customer|supplier|concentration|account(?:ed|s)? for|substantial portion|distributor|reseller|manufactured by|foundry|partner)/i;

/** Windows around concentration/relationship language — grounds named-link extraction. */
export function concentrationExcerpt(html: string, budget: number): string {
  const text = htmlToText(html);
  const hits: string[] = [];
  const re = new RegExp(CONCENTRATION_RE, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && hits.join(" ").length < budget) {
    hits.push(text.slice(Math.max(0, m.index - 400), m.index + 400));
    re.lastIndex = m.index + 800;
  }
  return hits.join("\n…\n").slice(0, budget);
}

/** Windows around caller-supplied keywords — the deepening loop's targeted re-read of the filing to
 *  chase down unverified claims / missing sources without re-feeding the whole document. */
export function keywordExcerpts(html: string, keywords: string[], budget: number): string {
  if (!keywords.length || budget <= 0) return "";
  const text = htmlToText(html);
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const kw of keywords) {
    const k = kw.toLowerCase().trim();
    if (k.length < 4) continue;
    let from = 0;
    let perKw = 0;
    let idx = lower.indexOf(k, from);
    while (idx >= 0 && perKw < 2 && hits.join(" ").length < budget) {
      hits.push(text.slice(Math.max(0, idx - 300), idx + 300));
      perKw++;
      from = idx + 600;
      idx = lower.indexOf(k, from);
    }
  }
  return hits.join("\n…\n").slice(0, budget);
}

const MDA_START = /Management.{0,3}s Discussion and Analysis/gi;
const MDA_END = /(Quantitative and Qualitative Disclosures|Controls and Procedures|Item\s+[34][A-Za-z]?\b|Financial Statements and Supplementary|Legal Proceedings)/i;

/**
 * Slice the Management's Discussion & Analysis section (10-K Item 7 / 10-Q Item 2). The heading
 * appears in the table of contents AND at the real section; we take the LAST occurrence (the TOC
 * entry comes first) and cut at the next major item heading. Falls back to the document head.
 */
export function extractMdaSection(html: string, budget: number): string {
  const text = htmlToText(html);
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(MDA_START);
  while ((m = re.exec(text))) starts.push(m.index);
  if (!starts.length) return text.slice(0, budget);

  const start = starts[starts.length - 1];
  const after = text.slice(start);
  // Skip the first ~120 chars (the heading itself) before looking for the end marker.
  const end = MDA_END.exec(after.slice(120));
  const section = end ? after.slice(0, end.index + 120) : after;
  return section.slice(0, budget);
}
