/* ============================================================
   Copy Match Checker — Punch Toolkit
   MVP logic: doc parsing, page extraction, comparison,
   acronym consistency, reporting + CSV export.
   ============================================================ */

// pdf.js worker
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---- State ----
const state = {
  approvedText: "",
  approvedSource: "",   // 'file' | 'gdoc' | 'paste'
  pageText: "",
  pageBlocks: [],
  pageCtas: [],
  pageLinks: [],
  issues: [],
  acronyms: [],
};

/* ========================================================
   TEXT UTILITIES
   ======================================================== */
function normalize(s) {
  return (s || "")
    .replace(/\s+/g, " ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .trim();
}
function normKey(s) {
  return normalize(s).toLowerCase().replace(/[^\w\s]/g, "").trim();
}
function splitBlocks(text) {
  // paragraph/line based, then keep meaningful units
  return text
    .split(/\n+/)
    .map((l) => normalize(l))
    .filter((l) => l.length > 1);
}
function splitSentences(text) {
  return normalize(text)
    .split(/(?<=[.!?:])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

// Levenshtein distance (capped for perf)
function lev(a, b) {
  a = a || ""; b = b || "";
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    let cur = [i];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}
function similarity(a, b) {
  a = normKey(a); b = normKey(b);
  if (!a && !b) return 1;
  if (!a || !b) return 0;

  const setA = new Set(a.split(" ")), setB = new Set(b.split(" "));
  let inter = 0; setA.forEach((t) => setB.has(t) && inter++);
  const minSize = Math.min(setA.size, setB.size);

  const maxLen = Math.max(a.length, b.length);
  let levRatio;
  if (maxLen > 400) {
    levRatio = inter / (setA.size + setB.size - inter || 1); // Jaccard guard for long strings
  } else {
    levRatio = 1 - lev(a, b) / maxLen;
  }

  // Containment: how much of the SHORTER block is contained in the longer one.
  // This catches a sentence that was shortened on the page (e.g. the full
  // acronym definition dropped) so it scores as a mismatch, not missing+extra.
  // Only applied when the shorter side has enough tokens to avoid generic
  // short phrases ("Learn more") over-matching unrelated content.
  if (minSize >= 4) {
    const containment = inter / minSize;
    return Math.max(levRatio, 0.5 * levRatio + 0.5 * containment);
  }
  return levRatio;
}

/* ========================================================
   DOCUMENT PARSERS (PDF + DOCX)
   ======================================================== */
async function parsePdf(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let out = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    // group items into lines by their y position
    let lastY = null, line = [];
    const lines = [];
    content.items.forEach((it) => {
      const y = it.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 4) {
        lines.push(line.join(" ")); line = [];
      }
      line.push(it.str); lastY = y;
    });
    if (line.length) lines.push(line.join(" "));
    out.push(lines.join("\n"));
  }
  return out.join("\n");
}

async function parseDocx(arrayBuffer) {
  const res = await mammoth.extractRawText({ arrayBuffer });
  return res.value || "";
}

async function handleFile(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  const buf = await file.arrayBuffer();
  let text = "";
  if (ext === "pdf") text = await parsePdf(buf);
  else if (ext === "docx") text = await parseDocx(buf);
  else throw new Error("Unsupported file type. Use PDF or DOCX.");
  return text;
}

/* ========================================================
   PAGE FETCH + VISIBLE TEXT EXTRACTION
   ======================================================== */
async function fetchPageHtml(url) {
  // Public CORS proxies, tried in order. Each has a timeout so a dead/slow
  // proxy can't hang the whole run. `json:true` proxies wrap the page in
  // {"contents": "..."} (allorigins/get) — more reliable on hosts (e.g. WP
  // Engine) that 403 the plain "raw" proxy.
  const proxies = [
    { name: "corsproxy.io",     make: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,        json: false },
    { name: "allorigins (json)", make: (u) => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`, json: true },
    { name: "allorigins (raw)", make: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`, json: false },
    { name: "codetabs",         make: (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`, json: false },
  ];
  const errors = [];
  for (const p of proxies) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 13000);
    try {
      const res = await fetch(p.make(url), { redirect: "follow", signal: ctrl.signal });
      if (res.ok) {
        let t = await res.text();
        if (p.json) { try { t = JSON.parse(t).contents || ""; } catch (_) {} }
        if (t && t.length > 50) return t;
        errors.push(`${p.name}: empty`);
      } else {
        errors.push(`${p.name}: HTTP ${res.status}`);
      }
    } catch (e) {
      errors.push(`${p.name}: ${e.name === "AbortError" ? "timeout" : (e.message || e)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  const e = new Error("All proxies failed — " + errors.join(" · "));
  e.proxyErrors = errors;
  throw e;
}

function detectCms(html) {
  if (/wp-content|wp-includes|wordpress/i.test(html)) return "WordPress";
  if (/hubspot|hs-scripts|hsforms|hubspotusercontent/i.test(html)) return "HubSpot";
  return "Static / Unknown";
}

// Extract visible text from raw HTML using a detached DOM.
function extractVisible(html, scope) {
  const doc = new DOMParser().parseFromString(html, "text/html");

  // strip non-visible
  doc.querySelectorAll("script,style,noscript,template,svg,iframe").forEach((n) => n.remove());

  // scope handling
  if (!scope.nav) doc.querySelectorAll("nav,[role=navigation],header .menu").forEach((n) => n.remove());
  if (!scope.footer) doc.querySelectorAll("footer,[role=contentinfo]").forEach((n) => n.remove());

  const root =
    (scope.mainOnly && (doc.querySelector("main") || doc.querySelector("[role=main]") || doc.querySelector("article"))) ||
    doc.body || doc;

  // ---- CTAs / buttons ----
  const ctas = [];
  if (scope.cta) {
    root.querySelectorAll("button, a.button, a.btn, a[class*=cta], a[class*=button], [role=button], input[type=submit]").forEach((el) => {
      const t = normalize(el.value || el.textContent);
      if (t && t.length < 80) ctas.push(t);
    });
  }
  // ---- Links ----
  const links = [];
  if (scope.links) {
    root.querySelectorAll("a[href]").forEach((el) => {
      const t = normalize(el.textContent);
      const href = el.getAttribute("href") || "";
      if (t && !/^#/.test(href)) links.push({ text: t, href });
    });
  }

  // ---- Visible text blocks (headings, paragraphs, list items, CTAs) ----
  const blocks = [];
  root.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,blockquote,td,th,figcaption,button,a")
    .forEach((el) => {
      // skip if an ancestor block already captured (avoid heavy dup) — keep leaf-ish text
      const t = normalize(el.textContent);
      if (t && t.length > 1) blocks.push({ text: t, tag: el.tagName.toLowerCase() });
    });

  // de-dup consecutive identical
  const seen = new Set();
  const cleanBlocks = blocks.filter((b) => {
    const k = normKey(b.text);
    if (!k || seen.has(k)) return false;
    seen.add(k); return true;
  });

  const fullText = cleanBlocks.map((b) => b.text).join("\n");
  return { blocks: cleanBlocks, fullText, ctas: [...new Set(ctas)], links };
}

/* ========================================================
   COMPARISON ENGINE
   ======================================================== */
function ctaTag(tag) { return tag === "button" || tag === "a"; }

function compareCopy(approvedText, page, scope) {
  const issues = [];
  const approvedBlocks = splitBlocks(approvedText);
  const pageBlocks = page.blocks.map((b) => b.text);
  const usedPage = new Array(pageBlocks.length).fill(false);

  let matched = 0;

  // 1) For each approved block, find best page match
  approvedBlocks.forEach((ab) => {
    let best = -1, bestSim = 0;
    pageBlocks.forEach((pb, i) => {
      const s = similarity(ab, pb);
      if (s > bestSim) { bestSim = s; best = i; }
    });

    const section = sectionGuess(ab);
    const looksCta = ab.split(" ").length <= 6 && /\b(download|learn|get|contact|sign|start|request|read|view|book|schedule|register|explore|see|join)\b/i.test(ab);

    if (bestSim >= 0.95) {
      matched++;
      if (best >= 0) usedPage[best] = true;
    } else if (bestSim >= 0.55) {
      matched += 0.5;
      if (best >= 0) usedPage[best] = true;
      issues.push({
        priority: looksCta ? "High" : "Medium",
        section,
        type: looksCta ? "CTA Issue" : "Copy Mismatch",
        approved: ab,
        current: pageBlocks[best],
        fix: looksCta
          ? `Update button/link text to match approved copy: "${ab}".`
          : `Reword to match approved copy. Approved: "${ab}".`,
        sim: bestSim,
      });
    } else {
      issues.push({
        priority: looksCta ? "High" : "High",
        section,
        type: looksCta ? "CTA Issue" : "Missing Copy",
        approved: ab,
        current: "—",
        fix: looksCta
          ? `Add the approved CTA "${ab}" to the page.`
          : `Add the approved copy to the page: "${ab}".`,
        sim: bestSim,
      });
    }
  });

  // 2) Page blocks not matched to any approved block => Extra
  pageBlocks.forEach((pb, i) => {
    if (usedPage[i]) return;
    // ignore very short fragments / common nav noise
    if (pb.length < 12) return;
    // skip if it's actually similar to some approved block (loose)
    let maxSim = 0;
    approvedBlocks.forEach((ab) => { maxSim = Math.max(maxSim, similarity(ab, pb)); });
    if (maxSim >= 0.55) return;
    issues.push({
      priority: "Medium",
      section: sectionGuess(pb),
      type: "Extra Section",
      approved: "—",
      current: pb,
      fix: "Confirm this content is approved, or remove it if it is outdated / leftover.",
      sim: 0,
    });
  });

  // 3) Mechanical checks on page text (typos / spacing / punctuation)
  page.blocks.forEach((b) => {
    const t = b.text;
    if (/\s{2,}/.test(t)) {
      issues.push(mech("Spacing Issue", "Low", b, t.replace(/\s{2,}/g, " "), "Remove the extra spaces."));
    }
    if (/\s+[,.;:!?]/.test(t)) {
      issues.push(mech("Punctuation Issue", "Low", b, t.replace(/\s+([,.;:!?])/g, "$1"), "Remove the space before punctuation."));
    }
    if (/(\b\w+\b)\s+\1\b/i.test(t)) {
      issues.push(mech("Typo", "Medium", b, t, "Possible repeated word — review."));
    }
  });

  // 4) Link review (informational, Low)
  if (scope.links) {
    page.links.slice(0, 40).forEach((l) => {
      if (/^(javascript:|mailto:|tel:)/i.test(l.href)) return;
      // flag obviously broken/placeholder links
      if (/(example\.com|localhost|#$|undefined|null)/i.test(l.href) || l.href.trim() === "") {
        issues.push({
          priority: "Low", section: "Links", type: "Link Review",
          approved: "—", current: `${l.text} → ${l.href}`,
          fix: "Review this link target — looks like a placeholder.", sim: 0,
        });
      }
    });
  }

  const total = approvedBlocks.length || 1;
  const score = Math.max(0, Math.min(100, Math.round((matched / total) * 100)));
  return { issues, score, approvedCount: approvedBlocks.length, pageCount: pageBlocks.length };
}

function mech(type, priority, block, fixedText, fix) {
  return {
    priority, section: sectionGuess(block.text), type,
    approved: "—", current: block.text, fix, sim: 1,
  };
}

// crude section guesser from heading-ish text
function sectionGuess(text) {
  const t = text.trim();
  const w = t.split(" ").length;
  if (w <= 6) return t.length > 40 ? t.slice(0, 40) + "…" : t;
  return t.slice(0, 32) + "…";
}

/* ========================================================
   ACRONYM CONSISTENCY CHECKER
   ======================================================== */
const ACRONYM_RE = /\b([A-Z][A-Za-z]*&?[A-Z][A-Za-z&]*)\b/g; // CMMC, POA&M, ConMon, ATO...

// Built-in seed dictionary (Phase 2 will allow per-client dictionaries).
// Keyed by FAMILY = canonical letters, uppercased, '&' removed.
// `canonical` is the correct spelling/casing; `full` is the expected long form.
const ACRONYM_DICTIONARY = {
  CMMC:    { canonical: "CMMC",    full: "Cybersecurity Maturity Model Certification" },
  POAM:    { canonical: "POA&M",   full: "Plan of Action and Milestones" },
  CONMON:  { canonical: "ConMon",  full: "Continuous Monitoring" },
  ATO:     { canonical: "ATO",     full: "Authority to Operate" },
  FEDRAMP: { canonical: "FedRAMP", full: "Federal Risk and Authorization Management Program" },
  NIST:    { canonical: "NIST",    full: "National Institute of Standards and Technology" },
  SSP:     { canonical: "SSP",     full: "System Security Plan" },
  RMF:     { canonical: "RMF",     full: "Risk Management Framework" },
};

function acronymFamily(a) {
  return a.replace(/&/g, "").toUpperCase(); // POA&M & POAM -> POAM ; ConMon -> CONMON
}

// Build a case-insensitive regex that matches any spelling of a family's
// letters with optional '&' between them: family "POAM" matches POAM / POA&M;
// "CONMON" matches ConMon / Conmon / CONMON.
function familyRegex(fam) {
  const letters = fam.replace(/&/g, "").split("");
  return new RegExp("\\b" + letters.join("&?") + "\\b", "gi");
}

/* ---- Per-client acronym dictionaries (localStorage) ---- */
const DICTS_KEY = "cmc_dicts_v1";
function loadDicts() {
  try { return JSON.parse(localStorage.getItem(DICTS_KEY) || "{}"); }
  catch { return {}; }
}
function saveDicts(obj) {
  try { localStorage.setItem(DICTS_KEY, JSON.stringify(obj)); }
  catch (e) { console.warn("Dictionary save failed", e); }
}
function currentClientKey() {
  const c = (typeof document !== "undefined" && document.querySelector("#clientName"))
    ? document.querySelector("#clientName").value.trim().toLowerCase() : "";
  return c || "__default__";
}
function getClientDict() {
  return loadDicts()[currentClientKey()] || {};
}
// built-in + client custom (custom overrides built-in for the same family)
function getActiveDictionary() {
  return { ...ACRONYM_DICTIONARY, ...getClientDict() };
}

function checkAcronyms(text, dictionary) {
  const DICT = dictionary || getActiveDictionary();
  const flat = normalize(text);
  const results = [];
  const found = {}; // family -> { variants:Set, firstIdx, defs:[], count }

  function record(fam, token, idx) {
    if (!found[fam]) found[fam] = { variants: new Set(), firstIdx: idx, defs: [], count: 0, seen: new Set() };
    const f = found[fam];
    if (f.seen.has(idx)) return; // same position matched by both the strict + dictionary pass
    f.seen.add(idx);
    f.variants.add(token);
    f.count++;
    if (idx < f.firstIdx) f.firstIdx = idx;
    // is this occurrence a definition?  "Full Form Words (TOKEN)"
    const before = flat.slice(Math.max(0, idx - 120), idx);
    const defMatch = before.match(/(?:[A-Z][a-zA-Z]+[\s-]+){1,8}\(\s*$/);
    if (defMatch) {
      f.defs.push({ idx, fullForm: defMatch[0].replace(/\(\s*$/, "").trim() });
    }
  }

  // 1) Strict auto-detection (>=2 uppercase letters)
  let m;
  ACRONYM_RE.lastIndex = 0;
  while ((m = ACRONYM_RE.exec(flat)) !== null) {
    const token = m[1];
    const uppers = (token.match(/[A-Z]/g) || []).length;
    if (uppers < 2 || token.length > 8) continue;
    record(acronymFamily(token), token, m.index);
  }

  // 2) Dictionary pass — catches low-uppercase variations (Conmon, Poam...)
  //    that the strict pass misses, so casing/format issues are still flagged.
  Object.keys(DICT).forEach((fam) => {
    const re = familyRegex(fam);
    let dm;
    while ((dm = re.exec(flat)) !== null) {
      record(fam, dm[0], dm.index);
      if (re.lastIndex === dm.index) re.lastIndex++; // guard against zero-width
    }
  });

  Object.keys(found).forEach((fam) => {
    const f = found[fam];
    const dict = DICT[fam];
    const variantsArr = [...f.variants];
    const canonical = dict ? dict.canonical : variantsArr[0];
    const display = canonical;
    const firstMentionCtx = contextAround(flat, f.firstIdx, 48);

    // variants that don't match the canonical spelling/casing
    const offForm = variantsArr.filter((v) => v !== canonical);

    let priority = "Low", issue = "", fix = "";
    let expected = dict ? `${dict.full} (${canonical})` : `Full Term (${canonical})`;

    const hasDef = f.defs.length > 0;
    const firstDefIdx = hasDef ? Math.min(...f.defs.map((d) => d.idx)) : Infinity;

    if (offForm.length) {
      priority = "Medium";
      issue = `Inconsistent format / casing: found ${variantsArr.join(", ")}.`;
      fix = `Standardize on "${canonical}"${dict ? " (" + dict.full + " on first mention)" : ""}.`;
    } else if (!hasDef) {
      priority = "High";
      issue = "Acronym is never defined on the page.";
      fix = `Spell out on first mention: "${expected}".`;
    } else if (f.firstIdx < firstDefIdx) {
      priority = "High";
      issue = "Acronym is used before it is defined.";
      fix = `Move the full definition "${expected}" to the first mention.`;
    } else if (f.defs.length > 1) {
      priority = "Medium";
      issue = `Defined more than once (${f.defs.length}×).`;
      fix = "Keep the full definition only on the first mention; use the acronym after.";
    } else {
      // defined correctly at/near first mention
      const inconsistentForms = new Set(f.defs.map((d) => normKey(d.fullForm)));
      if (inconsistentForms.size > 1) {
        priority = "Medium";
        issue = "Full-term definition is inconsistent across the page.";
        fix = "Use the same full term every time you define it.";
      } else {
        priority = "Low";
        issue = "Correctly defined on first mention.";
        fix = "No action needed.";
        if (!dict && f.defs[0].fullForm) expected = `${f.defs[0].fullForm} (${canonical})`;
      }
    }

    results.push({
      priority, acronym: display,
      firstMention: firstMentionCtx,
      expected, issue, fix,
      ok: issue.startsWith("Correctly"),
      count: f.count,
    });
  });

  // sort: High > Medium > Low
  const order = { High: 0, Medium: 1, Low: 2 };
  results.sort((a, b) => order[a.priority] - order[b.priority]);
  return results;
}

function contextAround(text, idx, radius) {
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + radius);
  return (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "");
}

/* ========================================================
   RENDERING
   ======================================================== */
function priorityRank(p) { return { High: 0, Medium: 1, Low: 2 }[p] ?? 3; }

function renderAll(scroll) {
  // merge acronym issues into the main issue list for the table/filters
  const acrIssues = state.acronyms
    .filter((a) => !a.ok)
    .map((a) => ({
      priority: a.priority, section: "Acronyms", type: "Acronym Issue",
      approved: a.expected, current: a.firstMention,
      fix: `${a.issue} ${a.fix}`, sim: 0,
    }));

  // merge actionable Google Doc comments (drift / pending change) as issues
  const commentIssues = (state.gdocComments || [])
    .filter((c) => c.impactClass === "drift" || (c.impactClass === "pending" && c.suggestsChange))
    .map((c) => ({
      priority: c.impactClass === "drift" ? "High" : "Medium",
      section: "Google Doc",
      type: "Google Doc Comment Issue",
      approved: c.related || "—",
      current: c.text,
      fix: c.action,
      sim: 0,
    }));

  state.allIssues = [...state.issues, ...acrIssues, ...commentIssues].sort(
    (a, b) => priorityRank(a.priority) - priorityRank(b.priority)
  );

  renderSummary();
  renderTable("all");
  renderAcronyms();
  renderComments();
  $$("#issueTabs .tab").forEach((t) => t.classList.remove("active"));
  $('#issueTabs .tab[data-filter="all"]').classList.add("active");
  $("#results").classList.remove("hidden");
  if (scroll !== false) $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
}

function countType(type) {
  if (type === "all") return state.allIssues.length;
  if (type === "CTA Issue") return state.allIssues.filter((i) => i.type === "CTA Issue" || i.type === "Link Review").length;
  return state.allIssues.filter((i) => i.type === type).length;
}

function renderSummary() {
  const I = state.allIssues;
  $("#sTotal").textContent = I.length;
  $("#sMissing").textContent = I.filter((i) => i.type === "Missing Copy").length;
  $("#sMismatch").textContent = I.filter((i) => i.type === "Copy Mismatch").length;
  $("#sExtra").textContent = I.filter((i) => i.type === "Extra Section").length;
  $("#sAcr").textContent = I.filter((i) => i.type === "Acronym Issue").length;
  $("#sCta").textContent = I.filter((i) => i.type === "CTA Issue" || i.type === "Link Review").length;
  $("#sMatch").textContent = state.score + "%";

  $("#cAll").textContent = countType("all");
  $("#cMissing").textContent = countType("Missing Copy");
  $("#cMismatch").textContent = countType("Copy Mismatch");
  $("#cExtra").textContent = countType("Extra Section");
  $("#cAcr").textContent = countType("Acronym Issue");
  $("#cCta").textContent = countType("CTA Issue");
  $("#cGdoc").textContent = countType("Google Doc Comment Issue");

  $("#summaryMeta").textContent =
    `${state.meta.client || "—"} · ${state.meta.page || "—"} · ${state.meta.cms} · ${state.approvedCount} approved blocks vs ${state.pageCount} page blocks`;
}

function renderTable(filter) {
  const body = $("#issuesBody");
  let rows = state.allIssues;
  if (filter === "CTA Issue") rows = rows.filter((i) => i.type === "CTA Issue" || i.type === "Link Review");
  else if (filter !== "all") rows = rows.filter((i) => i.type === filter);

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="6" class="no-rows">🎉 No issues in this category.</td></tr>`;
    $("#rowCount").textContent = "0 issues";
    return;
  }

  body.innerHTML = rows.map((i) => `
    <tr>
      <td><span class="badge badge-${i.priority}">${i.priority}</span></td>
      <td>${esc(i.section)}</td>
      <td><span class="type-pill">${esc(i.type)}</span></td>
      <td class="cell-approved">${i.approved === "—" ? '<span class="empty-dash">—</span>' : esc(i.approved)}</td>
      <td class="cell-current">${i.current === "—" ? '<span class="empty-dash">—</span>' : esc(i.current)}</td>
      <td>${esc(i.fix)}</td>
    </tr>`).join("");

  $("#rowCount").textContent = `${rows.length} issue${rows.length === 1 ? "" : "s"}`;
}

function renderAcronyms() {
  $("#acrCount").textContent = state.acronyms.length;
  const el = $("#acronymList");
  if (!state.acronyms.length) {
    el.innerHTML = `<p class="muted small">No acronyms detected on the page.</p>`;
    return;
  }
  el.innerHTML = state.acronyms.map((a) => `
    <div class="acr-item">
      <div class="acr-top">
        <span class="acr-name">${esc(a.acronym)}</span>
        <span class="badge badge-${a.priority}">${a.priority}</span>
      </div>
      <div class="acr-meta">First mention: ${esc(a.firstMention)} · used ${a.count}×</div>
      <div class="acr-meta">Expected: <strong>${esc(a.expected)}</strong></div>
      <div class="acr-issue">⚠ ${esc(a.issue)}</div>
      <div class="acr-fix">→ ${esc(a.fix)}</div>
    </div>`).join("");
}

function renderComments() {
  const el = $("#gdocComments");
  const badge = $("#gdocBadge");
  const list = state.gdocComments || [];
  if (!list.length) {
    badge.textContent = state.googleConnected ? "Connected · 0 comments" : "Not connected";
    el.innerHTML = `<p class="muted small">Connect a Google Doc (or load demo data) to surface open / resolved threads,
      client &amp; copywriter feedback, and version drift between the latest doc and the page.</p>`;
    return;
  }
  badge.textContent = `${list.length} comment${list.length === 1 ? "" : "s"}`;
  el.innerHTML = `
    <div class="table-wrap">
      <table class="gdoc">
        <thead><tr>
          <th>Status</th><th>Comment or Feedback</th><th>Related Copy</th>
          <th>Possible Impact</th><th>Suggested Action</th>
        </tr></thead>
        <tbody>
          ${list.map((c) => `
            <tr>
              <td><span class="status-tag status-${c.resolved ? "resolved" : "open"}">${c.resolved ? "RESOLVED" : "OPEN"}</span></td>
              <td>${esc(c.text)}${c.replies && c.replies.length ? `<div class="muted small">↳ ${c.replies.length} repl${c.replies.length === 1 ? "y" : "ies"}: ${esc(c.replies.join(" · "))}</div>` : ""}${c.author ? `<div class="muted small">— ${esc(c.author)}</div>` : ""}</td>
              <td class="related">${c.related ? '"' + esc(c.related) + '"' : '<span class="empty-dash">—</span>'}</td>
              <td class="impact-${c.impactClass}">${esc(c.impact)}</td>
              <td>${esc(c.action)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

// Decide Possible Impact + Suggested Action from a raw comment + page text.
const CHANGE_WORDS = /\b(change|update|updated|revise|revised|reword|replace|remove|delete|add|should|fix|typo|incorrect|wrong|swap|edit|new copy|instead)\b/i;

function classifyComment(c, pageText) {
  const text = (c.text || "").trim();
  const related = (c.related || "").trim();
  const suggestsChange = CHANGE_WORDS.test(text) || (c.replies || []).some((r) => CHANGE_WORDS.test(r));
  const pageHasRelated = related && pageText
    ? pageText.toLowerCase().includes(normKey(related)) || similarity(related, bestPageLine(related, pageText)) >= 0.7
    : null;

  let impact, impactClass, action;

  if (!c.resolved) {
    // OPEN comment
    if (suggestsChange) {
      impact = "Possible pending copy change — not yet confirmed live.";
      impactClass = "pending";
      action = pageHasRelated === true
        ? "Open thread still references current live copy — confirm whether the change was applied or is pending."
        : pageHasRelated === false
        ? "Related copy not found on the page — verify the change was implemented correctly."
        : "Resolve the thread and verify the final wording against the page.";
    } else {
      impact = "Open question / feedback — may not affect copy.";
      impactClass = "pending";
      action = "Review the thread; confirm no copy change is required before launch.";
    }
  } else {
    // RESOLVED comment
    impact = "Resolved — change likely already approved/applied.";
    impactClass = "applied";
    action = pageHasRelated === false
      ? "Resolved edit may not be reflected on the page — verify the latest wording is live."
      : "Confirm the resolved wording matches what is published.";
    if (pageHasRelated === false) { impact = "Resolved in doc but related copy missing on page — possible version drift."; impactClass = "drift"; }
  }
  return { ...c, text, related, suggestsChange, impact, impactClass, action };
}

function bestPageLine(s, pageText) {
  let best = "", bestSim = 0;
  (pageText || "").split("\n").forEach((l) => {
    const sim = similarity(s, l);
    if (sim > bestSim) { bestSim = sim; best = l; }
  });
  return best;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ========================================================
   EXPORT
   ======================================================== */
function exportCsv() {
  const header = ["Priority", "Section", "Issue Type", "Approved Copy", "Current Page Copy", "Suggested Fix"];
  const rows = state.allIssues.map((i) => [i.priority, i.section, i.type, i.approved, i.current, i.fix]);
  // acronym section appended
  rows.push([], ["ACRONYM REVIEW"]);
  rows.push(["Priority", "Acronym", "First Mention", "Expected Format", "Issue", "Suggested Fix"]);
  state.acronyms.forEach((a) => rows.push([a.priority, a.acronym, a.firstMention, a.expected, a.issue, a.fix]));

  // google doc comments section appended
  if (state.gdocComments && state.gdocComments.length) {
    rows.push([], ["GOOGLE DOC COMMENTS REVIEW"]);
    rows.push(["Status", "Comment or Feedback", "Related Copy", "Possible Impact", "Suggested Action"]);
    state.gdocComments.forEach((c) =>
      rows.push([c.resolved ? "Resolved" : "Open", c.text, c.related || "", c.impact, c.action]));
  }

  const csv = [header, ...rows]
    .map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\r\n");

  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  const name = (state.meta.client || "copy") + "_" + (state.meta.page || "qa");
  a.href = URL.createObjectURL(blob);
  a.download = name.replace(/\s+/g, "_") + "_QA.csv";
  a.click();
  toast("CSV exported");
}

function copyReport() {
  let txt = `COPY MATCH CHECKER — QA REPORT\n`;
  txt += `Client: ${state.meta.client || "—"}  |  Page: ${state.meta.page || "—"}\n`;
  txt += `URL: ${state.meta.url}\nCMS: ${state.meta.cms}  |  Match score: ${state.score}%\n`;
  txt += `Total issues: ${state.allIssues.length}\n${"=".repeat(50)}\n\n`;
  state.allIssues.forEach((i, n) => {
    txt += `${n + 1}. [${i.priority}] ${i.type} — ${i.section}\n`;
    if (i.approved !== "—") txt += `   Approved: ${i.approved}\n`;
    if (i.current !== "—") txt += `   Current:  ${i.current}\n`;
    txt += `   Fix:      ${i.fix}\n\n`;
  });
  if (state.acronyms.length) {
    txt += `\nACRONYM REVIEW\n${"-".repeat(30)}\n`;
    state.acronyms.forEach((a) => {
      txt += `[${a.priority}] ${a.acronym} — ${a.issue} (${a.fix})\n`;
    });
  }
  if (state.gdocComments && state.gdocComments.length) {
    txt += `\nGOOGLE DOC COMMENTS REVIEW\n${"-".repeat(30)}\n`;
    state.gdocComments.forEach((c) => {
      txt += `[${c.resolved ? "Resolved" : "Open"}] ${c.text}\n`;
      if (c.related) txt += `   Related: ${c.related}\n`;
      txt += `   Impact: ${c.impact}\n   Action: ${c.action}\n\n`;
    });
  }
  navigator.clipboard.writeText(txt).then(
    () => toast("Report copied to clipboard"),
    () => toast("Copy failed — clipboard blocked")
  );
}

/* ========================================================
   UI WIRING
   ======================================================== */
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.add("hidden"), 2200);
}
function setApprovedStatus(msg, ok) {
  const el = $("#approvedStatus");
  el.textContent = msg;
  el.classList.toggle("ok", !!ok);
}

// Source tabs
$$(".src-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".src-tab").forEach((t) => t.classList.remove("active"));
    $$(".src-pane").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $(`.src-pane[data-pane="${tab.dataset.src}"]`).classList.add("active");
    state.approvedSource = tab.dataset.src;
  });
});
state.approvedSource = "file";

// Dropzone
const dz = $("#dropzone"), fileInput = $("#fileInput");
dz.addEventListener("click", () => fileInput.click());
dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
dz.addEventListener("drop", (e) => {
  e.preventDefault(); dz.classList.remove("drag");
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", (e) => e.target.files[0] && loadFile(e.target.files[0]));
$("#clearFile").addEventListener("click", (e) => {
  e.stopPropagation();
  state.approvedText = ""; fileInput.value = "";
  $("#dropFilled").classList.add("hidden");
  $("#dropEmpty").classList.remove("hidden");
  setApprovedStatus("No approved copy loaded yet.", false);
});

async function loadFile(file) {
  try {
    setApprovedStatus("Parsing " + file.name + "…", false);
    const text = await handleFile(file);
    const blocks = splitBlocks(text).length;

    // Guard: a scanned/image PDF or an empty doc yields no usable text.
    if (!text || !text.trim() || blocks === 0) {
      state.approvedText = "";
      $("#dropEmpty").classList.remove("hidden");
      $("#dropFilled").classList.add("hidden");
      setApprovedStatus(
        "✕ No text found in this file. If it's a scanned/image PDF, paste the copy in the 'Paste Copy' tab instead.",
        false
      );
      toast("No readable text in file");
      return;
    }

    state.approvedText = text;
    state.approvedSource = "file";
    $("#fileName").textContent = file.name;
    $("#fileMeta").textContent = `${file.name.split(".").pop().toUpperCase()} · ${(file.size / 1024).toFixed(0)} KB`;
    $("#dropEmpty").classList.add("hidden");
    $("#dropFilled").classList.remove("hidden");
    setApprovedStatus(`✓ Loaded ${blocks} copy blocks from ${file.name}.`, true);
  } catch (err) {
    state.approvedText = "";
    setApprovedStatus("✕ " + (err.message || "Could not read file") +
      ". Use .pdf or .docx (not old .doc), or paste the copy instead.", false);
    toast("Failed to read file");
  }
}

// Google Doc loader (export as text via published endpoint).
// Returns true on success so run() can auto-load when only a URL was pasted.
async function loadGdocText() {
  const url = $("#gdocUrl").value.trim();
  const idMatch = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (!idMatch) { toast("Paste a valid Google Doc URL"); return false; }
  const id = idMatch[1];
  const exportUrl = `https://docs.google.com/document/d/${id}/export?format=txt`;
  setApprovedStatus("Loading Google Doc…", false);
  try {
    const txt = await fetchPageHtml(exportUrl); // reuse proxy
    if (!txt || !txt.trim() || splitBlocks(txt).length === 0) {
      setApprovedStatus("✕ Google Doc opened but no text was returned. Make sure it is shared 'Anyone with the link', or use 'Connect Google'.", false);
      return false;
    }
    state.approvedText = txt;
    state.approvedSource = "gdoc";
    setApprovedStatus(`✓ Loaded ${splitBlocks(txt).length} blocks from Google Doc.`, true);
    return true;
  } catch (e) {
    setApprovedStatus("✕ Could not load — share the doc as 'Anyone with the link', or use 'Connect Google (comments)' to authorize.", false);
    return false;
  }
}
$("#loadGdoc").addEventListener("click", async () => { if (await loadGdocText()) toast("Google Doc loaded"); });

/* ========================================================
   GOOGLE DOCS — comments & replies via Drive API (OAuth)
   ======================================================== */
state.gdocComments = [];
state.gdocRaw = [];
state.runs = [];
state.activeRun = 0;
state.googleConnected = false;
let gTokenClient = null;
let gAccessToken = null;

function gauthStatus(msg, ok) {
  const el = $("#gauthStatus");
  el.textContent = msg;
  el.classList.toggle("ok", !!ok);
}
function docIdFromUrl(url) {
  const m = (url || "").match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// Connect with Google Identity Services and pull comments.
$("#connectGoogle").addEventListener("click", () => {
  const clientId = $("#gClientId").value.trim();
  const docId = docIdFromUrl($("#gdocUrl").value.trim());
  if (!clientId) { toast("Add your OAuth Client ID first (setup section)"); $("#gClientId").focus(); return; }
  if (!docId) { toast("Paste a valid Google Doc URL"); return; }
  if (!window.google || !google.accounts || !google.accounts.oauth2) {
    toast("Google library not loaded — check your connection"); return;
  }
  gauthStatus("Opening Google sign-in…", false);
  try {
    gTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: "https://www.googleapis.com/auth/drive.readonly",
      callback: async (resp) => {
        if (resp.error) { gauthStatus("✕ Authorization failed: " + resp.error, false); return; }
        gAccessToken = resp.access_token;
        state.googleConnected = true;
        gauthStatus("✓ Connected. Loading comments…", true);
        try {
          await loadGoogleData(docId);
        } catch (e) {
          gauthStatus("✕ " + (e.message || e), false);
        }
      },
    });
    gTokenClient.requestAccessToken({ prompt: "consent" });
  } catch (e) {
    gauthStatus("✕ " + (e.message || e), false);
  }
});

async function loadGoogleData(docId) {
  // 1) document text (export) — also gives us the latest copy
  const exportRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=text/plain`,
    { headers: { Authorization: "Bearer " + gAccessToken } }
  );
  if (exportRes.ok) {
    const txt = await exportRes.text();
    state.approvedText = txt;
    state.approvedSource = "gdoc";
    setApprovedStatus(`✓ Loaded ${splitBlocks(txt).length} blocks from Google Doc.`, true);
  }

  // 2) comments + replies
  const fields = "comments(author/displayName,content,resolved,quotedFileContent/value,replies(content,author/displayName))";
  const cRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${docId}/comments?fields=${encodeURIComponent(fields)}&pageSize=100`,
    { headers: { Authorization: "Bearer " + gAccessToken } }
  );
  if (!cRes.ok) throw new Error("Drive comments request failed (" + cRes.status + "). Check API + scopes.");
  const data = await cRes.json();
  const raw = (data.comments || []).map((c) => ({
    text: c.content || "",
    author: c.author && c.author.displayName,
    resolved: !!c.resolved,
    related: c.quotedFileContent && c.quotedFileContent.value,
    replies: (c.replies || []).map((r) => r.content).filter(Boolean),
  }));
  ingestComments(raw);
  gauthStatus(`✓ Connected · ${raw.length} comments loaded.`, true);
  toast(`Loaded ${raw.length} Google Doc comments`);
}

// Classify + render a set of raw comments (shared by Drive + demo).
function ingestComments(raw) {
  state.gdocRaw = raw;
  classifyForActive();
  if (state.meta) {
    renderAll(false); // merge drift/pending comments into the full report + table
  } else {
    renderComments(); // demo before any run: show the comments table only
    $("#results").classList.remove("hidden");
  }
}

// Demo data so the output is testable without OAuth.
$("#demoComments").addEventListener("click", () => {
  ingestComments([
    {
      text: "Client asked to change 'illustrative examples' to 'documentation examples'.",
      author: "Copywriter", resolved: true,
      related: "This domain is for use in illustrative examples in documents.",
      replies: ["Updated in the doc.", "Approved — thanks!"],
    },
    {
      text: "Should we keep this CTA? Marketing wants to test removing it.",
      author: "Client", resolved: false,
      related: "More information...", replies: [],
    },
    {
      text: "Typo here — 'complianne' should be 'compliance'.",
      author: "QA", resolved: false,
      related: "Fortreum helps organizations achieve complianne.", replies: ["Good catch."],
    },
    {
      text: "Spell out CMMC on first mention per style guide.",
      author: "Editor", resolved: true,
      related: "Cybersecurity Maturity Model Certification (CMMC)", replies: [],
    },
  ]);
  toast("Demo comments loaded");
});

// Fetch method toggle
$("#fetchMethod").addEventListener("change", (e) => {
  $("#pastePageWrap").style.display = e.target.value === "paste" ? "block" : "none";
});

// Paste-approved sync
$("#pasteApproved").addEventListener("input", (e) => {
  if ($(".src-tab.active").dataset.src === "paste") {
    state.approvedText = e.target.value;
    state.approvedSource = "paste";
  }
});

// Modal
$("#howItWorksBtn").addEventListener("click", () => $("#howModal").classList.remove("hidden"));
$("#closeHow").addEventListener("click", () => $("#howModal").classList.add("hidden"));
$("#howModal").addEventListener("click", (e) => { if (e.target.id === "howModal") $("#howModal").classList.add("hidden"); });

// Tabs filter
$$("#issueTabs .tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$("#issueTabs .tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    renderTable(tab.dataset.filter);
  });
});

$("#exportCsv").addEventListener("click", exportCsv);
$("#copyReport").addEventListener("click", copyReport);

/* ========================================================
   RUN
   ======================================================== */
$("#runBtn").addEventListener("click", run);

async function run() {
  // gather approved text
  const activeSrc = $(".src-tab.active").dataset.src;
  if (activeSrc === "paste") {
    state.approvedText = $("#pasteApproved").value;
    state.approvedSource = "paste";
  }
  // auto-load the Google Doc if a URL was pasted but nothing loaded yet
  if (!(state.approvedText || "").trim() && activeSrc === "gdoc" && $("#gdocUrl").value.trim()) {
    toast("Loading Google Doc…");
    await loadGdocText();
  }
  const approved = (state.approvedText || "").trim();
  if (!approved) {
    toast(activeSrc === "gdoc"
      ? "Click 'Load text (no login)' or 'Connect Google' to load the doc first"
      : "Load or paste the approved copy first");
    return;
  }

  const method = $("#fetchMethod").value;
  const urls = $("#pageUrl").value.split(/[\n,]+/).map((u) => u.trim()).filter(Boolean);

  if (method === "proxy") {
    if (!urls.length || !urls.every((u) => /^https?:\/\//i.test(u))) {
      toast("Enter one or more valid page URLs (one per line)"); return;
    }
  }

  const scope = {
    mainOnly: $("#scMain").checked && !$("#scNav").checked && !$("#scFooter").checked,
    nav: $("#scNav").checked,
    footer: $("#scFooter").checked,
    cta: $("#scCta").checked,
    links: $("#scLinks").checked,
  };

  const meta = {
    client: $("#clientName").value.trim(),
    page: $("#pageName").value.trim(),
  };

  const btn = $("#runBtn");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Running…`;
  $("#runNote").textContent = "";

  // paste method = single page; proxy method = one run per URL
  const targets = method === "paste" ? ["(pasted page)"] : urls;
  const results = [];
  const errors = [];

  try {
    for (let i = 0; i < targets.length; i++) {
      const url = targets[i];
      try {
        let html;
        if (method === "paste") {
          html = $("#pastePage").value.trim();
          if (!html) throw new Error("Paste the page HTML / text first.");
          if (!/</.test(html)) html = "<body>" + html.split(/\n+/).map((l) => `<p>${l}</p>`).join("") + "</body>";
        } else {
          $("#runNote").textContent = `Fetching ${i + 1}/${targets.length}: ${url}`;
          html = await fetchPageHtml(url);
        }

        const cms = detectCms(html);
        const page = extractVisible(html, scope);
        if (!page.fullText || page.fullText.length < 20) {
          throw new Error("Could not extract readable text.");
        }

        const cmp = compareCopy(approved, page, scope);
        const acronyms = checkAcronyms(page.fullText);

        results.push({
          url, cms, pageText: page.fullText,
          issues: cmp.issues, acronyms, score: cmp.score,
          approvedCount: cmp.approvedCount, pageCount: cmp.pageCount,
          ctas: page.ctas.length, links: page.links.length,
          meta: { ...meta, url, cms },
        });
      } catch (e) {
        errors.push(`${url}: ${e.message || e}`);
      }
    }

    if (!results.length) {
      throw new Error(errors.join("\n") || "No pages could be checked.");
    }

    state.runs = results;
    activateRun(0, true);
    renderRunSwitcher();
    saveHistory(results, meta);

    const noteExtra = errors.length ? ` · ${errors.length} failed` : "";
    $("#runNote").textContent =
      `Done · ${results.length} page${results.length === 1 ? "" : "s"} checked${noteExtra}`;
    toast(`QA complete — ${results.length} page${results.length === 1 ? "" : "s"}`);
    if (errors.length) console.warn("Some URLs failed:\n" + errors.join("\n"));
  } catch (err) {
    $("#runNote").textContent = "";
    setApprovedStatus("", false);
    toast("Check failed");
    alert("Could not complete the check:\n\n" + (err.message || err) +
      "\n\nIf the page is password-protected (e.g. a WP Engine staging login) or " +
      "behind a firewall, no public proxy can read it.\n\nFix: switch 'Fetch method' to " +
      "'Paste page HTML / text', open the page in your browser, press Ctrl+U (view source) " +
      "and paste the HTML.");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `🔍 Run QA Check`;
  }
}

/* ========================================================
   MULTI-URL: activate a run + render the switcher
   ======================================================== */
function activateRun(i, scroll) {
  const r = state.runs[i];
  if (!r) return;
  state.activeRun = i;
  state.pageText = r.pageText;
  state.issues = r.issues;
  state.acronyms = r.acronyms;
  state.score = r.score;
  state.approvedCount = r.approvedCount;
  state.pageCount = r.pageCount;
  state.meta = r.meta;
  // classify the shared comments against THIS page's text (per-URL drift)
  classifyForActive();
  renderAll(scroll);
  renderRunSwitcher();
}

function classifyForActive() {
  state.gdocComments = (state.gdocRaw || []).map((c) => classifyComment(c, state.pageText || ""));
}

function hostOf(url) {
  try { return new URL(url).host + new URL(url).pathname.replace(/\/$/, ""); }
  catch { return url; }
}

function renderRunSwitcher() {
  const el = $("#runSwitcher");
  if (!state.runs || state.runs.length < 2) {
    // single URL: no switcher, and no compare view
    el.classList.add("hidden"); el.innerHTML = "";
    compareOpen = false; $("#compareCard").classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  const chips = state.runs.map((r, i) => {
    const n = r.issues.length + r.acronyms.filter((a) => !a.ok).length;
    return `<div class="run-chip ${i === state.activeRun ? "active" : ""}" data-run="${i}">
      <span class="chip-score c-green">${r.score}%</span>
      <span><span class="chip-host">${esc(hostOf(r.url))}</span>
      <span class="chip-issues"> · ${n} issue${n === 1 ? "" : "s"}</span></span>
    </div>`;
  }).join("");
  el.innerHTML = chips +
    `<button class="btn btn-outline compare-toggle ${compareOpen ? "active" : ""}" id="compareToggle">⚎ Compare URLs</button>`;
  $$("#runSwitcher .run-chip").forEach((chip) =>
    chip.addEventListener("click", () => activateRun(+chip.dataset.run, false)));
  $("#compareToggle").addEventListener("click", toggleCompare);
  // keep an open compare view in sync with the latest runs
  if (compareOpen) renderCompare();
}

/* ========================================================
   HISTORY (localStorage, per browser)
   ======================================================== */
const HISTORY_KEY = "cmc_history_v1";

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); }
  catch { return []; }
}
function saveHistory(results, meta) {
  // store a compact, restorable snapshot (timestamp injected by the UI layer)
  const batch = {
    id: "b" + (loadHistory().length + 1) + "_" + results.length + "_" + (meta.client || "x").slice(0, 8),
    client: meta.client || "—",
    page: meta.page || "—",
    when: new Date().toLocaleString(),
    runs: results.map((r) => ({
      url: r.url, cms: r.cms, pageText: r.pageText, issues: r.issues,
      acronyms: r.acronyms, score: r.score, approvedCount: r.approvedCount,
      pageCount: r.pageCount, ctas: r.ctas, links: r.links, meta: r.meta,
    })),
    gdocRaw: state.gdocRaw || [],
  };
  const hist = loadHistory();
  hist.unshift(batch);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(hist.slice(0, 25))); }
  catch (e) { console.warn("History save failed (quota?)", e); }
}
function renderHistory() {
  const list = $("#historyList");
  const hist = loadHistory();
  if (!hist.length) { list.innerHTML = `<div class="history-empty">No saved runs yet.</div>`; return; }
  list.innerHTML = hist.map((b, i) => {
    const totalIssues = b.runs.reduce((s, r) => s + r.issues.length, 0);
    const avg = Math.round(b.runs.reduce((s, r) => s + r.score, 0) / b.runs.length);
    return `<div class="history-item" data-hist="${i}">
      <div>
        <div class="h-title">${esc(b.client)} · ${esc(b.page)}</div>
        <div class="h-meta">${esc(b.when)} · ${b.runs.length} URL${b.runs.length === 1 ? "" : "s"} · ${totalIssues} issues</div>
      </div>
      <div class="h-score">${avg}%</div>
    </div>`;
  }).join("");
  $$("#historyList .history-item").forEach((it) =>
    it.addEventListener("click", () => restoreHistory(+it.dataset.hist)));
}
function restoreHistory(i) {
  const b = loadHistory()[i];
  if (!b) return;
  state.runs = b.runs;
  state.gdocRaw = b.gdocRaw || [];
  $("#clientName").value = b.client === "—" ? "" : b.client;
  $("#pageName").value = b.page === "—" ? "" : b.page;
  activateRun(0, true);
  renderRunSwitcher();
  $("#historyModal").classList.add("hidden");
  toast(`Restored: ${b.client} · ${b.page}`);
}

$("#historyBtn").addEventListener("click", () => { renderHistory(); $("#historyModal").classList.remove("hidden"); });
$("#closeHistory").addEventListener("click", () => $("#historyModal").classList.add("hidden"));
$("#historyModal").addEventListener("click", (e) => { if (e.target.id === "historyModal") $("#historyModal").classList.add("hidden"); });
$("#clearHistory").addEventListener("click", () => {
  localStorage.removeItem(HISTORY_KEY); renderHistory(); toast("History cleared");
});

/* ========================================================
   ACRONYM DICTIONARY — per-client management UI
   ======================================================== */
function renderDictModal() {
  const key = currentClientKey();
  $("#dictClient").textContent = key === "__default__" ? "(no client — global defaults)" : $("#clientName").value.trim();

  const custom = getClientDict();
  const list = $("#dictList");
  const fams = Object.keys(custom);
  list.innerHTML = fams.length
    ? fams.map((fam) => `
        <div class="dict-row" data-fam="${esc(fam)}">
          <span class="d-canon">${esc(custom[fam].canonical)}</span>
          <span class="d-full">${esc(custom[fam].full || "—")}</span>
          <button class="d-del" title="Remove">🗑</button>
        </div>`).join("")
    : `<div class="dict-empty">No custom acronyms for this client yet.</div>`;
  $$("#dictList .d-del").forEach((b) =>
    b.addEventListener("click", () => removeDictEntry(b.closest(".dict-row").dataset.fam)));

  $("#dictBuiltin").innerHTML = Object.values(ACRONYM_DICTIONARY)
    .map((d) => `<div><code>${esc(d.canonical)}</code> — ${esc(d.full)}</div>`).join("");
}

function addDictEntry(canon, full) {
  canon = (canon || "").trim();
  full = (full || "").trim();
  if (!canon) { toast("Enter the acronym"); return; }
  const fam = canon.replace(/&/g, "").toUpperCase();
  const dicts = loadDicts();
  const key = currentClientKey();
  dicts[key] = dicts[key] || {};
  dicts[key][fam] = { canonical: canon, full };
  saveDicts(dicts);
  $("#dictCanon").value = ""; $("#dictFull").value = "";
  renderDictModal();
  toast(`Added "${canon}" to ${key === "__default__" ? "global" : "client"} dictionary`);
}
function removeDictEntry(fam) {
  const dicts = loadDicts();
  const key = currentClientKey();
  if (dicts[key]) { delete dicts[key][fam]; saveDicts(dicts); }
  renderDictModal();
}

$("#dictBtn").addEventListener("click", () => { renderDictModal(); $("#dictModal").classList.remove("hidden"); });
$("#closeDict").addEventListener("click", () => $("#dictModal").classList.add("hidden"));
$("#dictModal").addEventListener("click", (e) => { if (e.target.id === "dictModal") $("#dictModal").classList.add("hidden"); });
$("#dictAdd").addEventListener("click", () => addDictEntry($("#dictCanon").value, $("#dictFull").value));
$("#dictFull").addEventListener("keydown", (e) => { if (e.key === "Enter") addDictEntry($("#dictCanon").value, $("#dictFull").value); });

/* ========================================================
   SIDE-BY-SIDE — issues across URLs
   ======================================================== */
let compareOpen = false;

function compareKey(it) {
  if (it.type === "Extra Section") return "Extra|" + normKey(it.current);
  if (it.type === "Acronym Issue") return "Acronym|" + (it.acronym || it.approved || "").toUpperCase();
  const base = it.approved && it.approved !== "—" ? it.approved : it.current;
  return it.type + "|" + normKey(base);
}

function buildCompareRows() {
  const map = new Map();
  state.runs.forEach((r, idx) => {
    const items = [
      ...r.issues,
      ...r.acronyms.filter((a) => !a.ok).map((a) => ({
        type: "Acronym Issue", priority: a.priority, acronym: a.acronym,
        approved: a.acronym, current: a.firstMention,
      })),
    ];
    items.forEach((it) => {
      const key = compareKey(it);
      if (!map.has(key)) {
        map.set(key, {
          type: it.type,
          detail: (it.approved && it.approved !== "—") ? it.approved : it.current,
          perUrl: {},
        });
      }
      map.get(key).perUrl[idx] = it.priority;
    });
  });
  const rows = [...map.values()].map((row) => ({
    ...row,
    affected: Object.keys(row.perUrl).length,
  }));
  // most-shared issues first, then by type
  rows.sort((a, b) => b.affected - a.affected || a.type.localeCompare(b.type));
  return rows;
}

function renderCompare() {
  const rows = buildCompareRows();
  const urls = state.runs.map((r) => hostOf(r.url));
  $("#compareMeta").textContent = `${rows.length} distinct issues across ${urls.length} URLs`;
  $("#compareBody").innerHTML = `
    <table class="compare">
      <thead><tr>
        <th>Issue Type</th><th>Detail</th>
        ${urls.map((u) => `<th class="c-url">${esc(u)}</th>`).join("")}
      </tr></thead>
      <tbody>
        ${rows.map((row) => `
          <tr>
            <td><span class="type-pill">${esc(row.type)}</span></td>
            <td class="c-detail">${esc((row.detail || "").slice(0, 120))}</td>
            ${state.runs.map((r, i) => {
              const p = row.perUrl[i];
              return `<td class="c-url">${p
                ? `<span class="cmp-dot badge-${p}">${p}</span>`
                : `<span class="cmp-na">✓</span>`}</td>`;
            }).join("")}
          </tr>`).join("")}
      </tbody>
    </table>`;
}

function toggleCompare() {
  compareOpen = !compareOpen;
  const card = $("#compareCard");
  if (compareOpen) { renderCompare(); card.classList.remove("hidden"); }
  else card.classList.add("hidden");
  const btn = $("#compareToggle");
  if (btn) btn.classList.toggle("active", compareOpen);
}
