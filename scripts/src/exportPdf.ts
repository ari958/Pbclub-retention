// @ts-nocheck
import PDFDocument from "pdfkit";
import MarkdownIt from "markdown-it";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../");

const md = new MarkdownIt({ html: false, breaks: false });

// ─── Colours & type scale ─────────────────────────────────────────────────────
const DARK_BG    = "#0f1117";
const ACCENT     = "#E8A838";
const WHITE      = "#e6edf3";
const MUTED      = "#8b949e";
const BORDER     = "#30363d";
const CODE_BG    = "#1e2530";

// For readability on white paper we flip to dark-on-white
const PAGE_BG    = "#ffffff";
const TEXT       = "#1a1f28";
const H1_COLOR   = "#1a1f28";
const H2_COLOR   = "#1a1f28";
const H3_COLOR   = "#444c56";
const ACCENT_PDF = "#b07e20";  // darker amber for print
const MUTED_PDF  = "#6e7681";
const CODE_BG_PDF= "#f3f4f6";
const BORDER_PDF = "#d0d7de";
const HR_COLOR   = "#d0d7de";

const MARGIN  = 54;
const WIDTH   = 595.28;          // A4
const HEIGHT  = 841.89;
const CONTENT = WIDTH - MARGIN * 2;

function makePdf(inputFile: string, outputFile: string) {
  const raw = fs.readFileSync(inputFile, "utf8");
  const tokens = md.parse(raw, {});

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    autoFirstPage: true,
    bufferPages: true,
    info: {
      Title: path.basename(inputFile, ".md"),
      Author: "Pulse — PB Club",
      Creator: "Pulse PDF Export",
    },
  });

  const out = fs.createWriteStream(outputFile);
  doc.pipe(out);

  // ── page background ─────────────────────────────────────────────────────────
  function fillPageBg() {
    doc.save().rect(0, 0, WIDTH, HEIGHT).fill(PAGE_BG).restore();
  }
  fillPageBg();
  doc.on("pageAdded", fillPageBg);

  // ── helpers ──────────────────────────────────────────────────────────────────
  function ensureRoom(needed: number) {
    if (doc.y + needed > HEIGHT - MARGIN) doc.addPage();
  }

  function gap(n = 6) { doc.moveDown(n / 12); }

  function hRule() {
    ensureRoom(18);
    gap(4);
    doc.save()
      .moveTo(MARGIN, doc.y)
      .lineTo(WIDTH - MARGIN, doc.y)
      .strokeColor(HR_COLOR).lineWidth(0.5).stroke()
      .restore();
    gap(8);
  }

  function renderInline(text: string, opts: {
    fontSize?: number;
    color?: string;
    bold?: boolean;
    italic?: boolean;
    x?: number;
    wrap?: number;
  } = {}) {
    const {
      fontSize = 10.5,
      color = TEXT,
      bold = false,
      italic = false,
      x = MARGIN,
      wrap = CONTENT,
    } = opts;

    // Parse bold/italic/code inline
    const parts: { text: string; bold: boolean; italic: boolean; code: boolean }[] = [];
    const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|__[^_]+__|_[^_]+_)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parts.push({ text: text.slice(last, m.index), bold, italic, code: false });
      const tok = m[0];
      if (tok.startsWith("`")) {
        parts.push({ text: tok.slice(1, -1), bold: false, italic: false, code: true });
      } else if (tok.startsWith("**") || tok.startsWith("__")) {
        parts.push({ text: tok.slice(2, -2), bold: true, italic, code: false });
      } else {
        parts.push({ text: tok.slice(1, -1), bold, italic: true, code: false });
      }
      last = m.index + tok.length;
    }
    if (last < text.length) parts.push({ text: text.slice(last), bold, italic, code: false });

    // Render as continuous text with mixed styles
    // We approximate by just rendering the full text with dominant style
    // (true mixed inline would need word-by-word measurement)
    const fullText = parts.map(p => p.text).join("");
    const hasBold = bold || parts.some(p => p.bold);
    const hasItalic = italic || parts.some(p => p.italic);
    const hasCode = parts.some(p => p.code);

    let font = "Helvetica";
    if (hasBold && hasItalic) font = "Helvetica-BoldOblique";
    else if (hasBold) font = "Helvetica-Bold";
    else if (hasItalic || hasCode) font = "Helvetica-Oblique";

    const fColor = hasCode ? ACCENT_PDF : color;

    doc.font(font).fontSize(fontSize).fillColor(fColor)
      .text(fullText, x, doc.y, { width: wrap, lineGap: 2 });
  }

  // ─── token renderer ──────────────────────────────────────────────────────────
  let inBulletList = false;
  let listDepth = 0;
  let inOrderedList = false;
  let orderedIndex = 0;
  let inTable = false;
  let tableHeaders: string[] = [];
  let tableRows: string[][] = [];
  let inTableHead = false;
  let inTableBody = false;
  let currentRow: string[] = [];
  let inCode = false;
  let codeLines: string[] = [];
  let inBlockquote = false;
  let bulletLevel = 0;

  function flushTable() {
    if (tableHeaders.length === 0) return;

    const colCount = tableHeaders.length;
    const colW = CONTENT / colCount;
    const cellPad = 6;
    const headerFontSize = 9;
    const bodyFontSize = 9;

    ensureRoom(40);

    // Header row
    const headerY = doc.y;
    doc.save().rect(MARGIN, headerY - 2, CONTENT, 20).fill("#f3f4f6").restore();

    tableHeaders.forEach((h, i) => {
      doc.font("Helvetica-Bold").fontSize(headerFontSize).fillColor(TEXT)
        .text(h.trim(), MARGIN + i * colW + cellPad, headerY + 2, { width: colW - cellPad * 2, lineBreak: false });
    });
    doc.y = headerY + 22;

    // Body rows
    tableRows.forEach((row, ri) => {
      ensureRoom(22);
      const rowY = doc.y;
      if (ri % 2 === 1) {
        doc.save().rect(MARGIN, rowY - 2, CONTENT, 20).fill("#f9fafb").restore();
      }
      row.forEach((cell, i) => {
        // strip markdown bold/inline code for table cells
        const clean = cell.trim().replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
        doc.font("Helvetica").fontSize(bodyFontSize).fillColor(TEXT)
          .text(clean, MARGIN + i * colW + cellPad, rowY + 2, { width: colW - cellPad * 2, lineBreak: false });
      });
      doc.y = rowY + 20;
    });

    // Bottom border
    doc.save().moveTo(MARGIN, doc.y).lineTo(WIDTH - MARGIN, doc.y)
      .strokeColor(BORDER_PDF).lineWidth(0.5).stroke().restore();

    doc.moveDown(0.5);
    tableHeaders = [];
    tableRows = [];
    currentRow = [];
    inTable = false;
  }

  function flushCode() {
    if (codeLines.length === 0) return;
    const text = codeLines.join("\n");
    const lineHeight = 11;
    const lines = codeLines.length;
    const blockH = lines * lineHeight + 16;

    ensureRoom(blockH + 8);
    const blockY = doc.y;

    doc.save().rect(MARGIN, blockY, CONTENT, blockH).fill(CODE_BG_PDF).restore();
    doc.save().rect(MARGIN, blockY, 3, blockH).fill(ACCENT_PDF).restore();

    doc.font("Courier").fontSize(8).fillColor("#444c56")
      .text(text, MARGIN + 12, blockY + 8, { width: CONTENT - 20, lineGap: 1 });

    doc.y = blockY + blockH + 8;
    codeLines = [];
    inCode = false;
  }

  // ─── main loop ───────────────────────────────────────────────────────────────
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    if (tok.type === "fence" || tok.type === "code_block") {
      codeLines = tok.content.split("\n");
      if (codeLines[codeLines.length - 1] === "") codeLines.pop();
      flushCode();
      continue;
    }

    if (tok.type === "html_block") continue;

    if (tok.type === "inline" && tok.content.startsWith("![")) {
      // Image — try to embed screenshot
      const imgMatch = tok.content.match(/!\[([^\]]*)\]\(([^)]+)\)/);
      if (imgMatch) {
        const imgPath = path.resolve(ROOT, imgMatch[2]);
        if (fs.existsSync(imgPath)) {
          ensureRoom(200);
          const maxW = CONTENT;
          try {
            doc.image(imgPath, MARGIN, doc.y, { width: maxW, align: "center" });
            gap(8);
            // caption
            if (imgMatch[1]) {
              doc.font("Helvetica-Oblique").fontSize(8).fillColor(MUTED_PDF)
                .text(imgMatch[1], MARGIN, doc.y, { width: CONTENT, align: "center" });
              gap(6);
            }
          } catch {
            // skip if image fails
          }
        }
      }
      continue;
    }

    switch (tok.type) {
      case "heading_open": {
        const level = parseInt(tok.tag.replace("h", ""), 10);
        const next = tokens[i + 1];
        const text = next?.type === "inline" ? next.content : "";
        i++; // skip inline
        // skip closing tag
        while (i < tokens.length && tokens[i].type !== `heading_close`) i++;

        if (level === 1) {
          ensureRoom(60);
          // Title block
          doc.save().rect(0, doc.y, WIDTH, 2).fill(ACCENT_PDF).restore();
          gap(12);
          doc.font("Helvetica-Bold").fontSize(22).fillColor(H1_COLOR)
            .text(text, MARGIN, doc.y, { width: CONTENT });
          gap(6);
          doc.save().rect(0, doc.y, WIDTH, 1).fill(BORDER_PDF).restore();
          gap(10);
        } else if (level === 2) {
          ensureRoom(40);
          gap(10);
          doc.save().rect(MARGIN, doc.y + 2, 3, 16).fill(ACCENT_PDF).restore();
          doc.font("Helvetica-Bold").fontSize(15).fillColor(H2_COLOR)
            .text(text, MARGIN + 10, doc.y, { width: CONTENT - 10 });
          gap(4);
          doc.save().moveTo(MARGIN, doc.y).lineTo(WIDTH - MARGIN, doc.y)
            .strokeColor(BORDER_PDF).lineWidth(0.5).stroke().restore();
          gap(6);
        } else if (level === 3) {
          ensureRoom(30);
          gap(8);
          doc.font("Helvetica-Bold").fontSize(12).fillColor(H3_COLOR)
            .text(text, MARGIN, doc.y, { width: CONTENT });
          gap(4);
        } else {
          ensureRoom(22);
          gap(4);
          doc.font("Helvetica-Bold").fontSize(10.5).fillColor(ACCENT_PDF)
            .text(text, MARGIN, doc.y, { width: CONTENT });
          gap(2);
        }
        break;
      }

      case "paragraph_open":
        break;

      case "paragraph_close":
        gap(6);
        break;

      case "inline": {
        if (inTable) {
          currentRow.push(tok.content);
          break;
        }
        // strip image markdown entirely from inline text
        const cleaned = tok.content.replace(/!\[[^\]]*\]\([^)]*\)/g, "").trim();
        if (!cleaned) break;

        const x = inBlockquote ? MARGIN + 16 : MARGIN;
        const wrap = inBlockquote ? CONTENT - 16 : CONTENT;
        const color = inBlockquote ? MUTED_PDF : TEXT;

        doc.font("Helvetica").fontSize(10.5).fillColor(color);
        // Render bold/italic/code inline by approximation
        const hasBold = /\*\*[^*]+\*\*/.test(cleaned);
        const hasItalic = /\*[^*]+\*/.test(cleaned) || /`[^`]+`/.test(cleaned);
        const strippedText = cleaned
          .replace(/\*\*([^*]+)\*\*/g, "$1")
          .replace(/\*([^*]+)\*/g, "$1")
          .replace(/`([^`]+)`/g, "$1")
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); // strip links

        const font = hasBold ? "Helvetica-Bold" : hasItalic ? "Helvetica-Oblique" : "Helvetica";
        doc.font(font).fontSize(10.5).fillColor(color)
          .text(strippedText, x, doc.y, { width: wrap, lineGap: 2 });
        break;
      }

      case "bullet_list_open":
        inBulletList = true;
        bulletLevel++;
        break;

      case "bullet_list_close":
        bulletLevel--;
        if (bulletLevel === 0) { inBulletList = false; gap(4); }
        break;

      case "ordered_list_open":
        inOrderedList = true;
        orderedIndex = 0;
        bulletLevel++;
        break;

      case "ordered_list_close":
        bulletLevel--;
        inOrderedList = false;
        gap(4);
        break;

      case "list_item_open":
        break;

      case "list_item_close":
        break;

      case "blockquote_open":
        inBlockquote = true;
        doc.save().rect(MARGIN, doc.y, 3, 1).fill(ACCENT_PDF).restore();
        break;

      case "blockquote_close":
        inBlockquote = false;
        gap(4);
        break;

      case "hr":
        hRule();
        break;

      case "table_open":
        inTable = true;
        tableHeaders = [];
        tableRows = [];
        break;

      case "table_close":
        flushTable();
        break;

      case "thead_open":
        inTableHead = true;
        break;

      case "thead_close":
        inTableHead = false;
        tableHeaders = [...currentRow];
        currentRow = [];
        break;

      case "tbody_open":
        inTableBody = true;
        break;

      case "tbody_close":
        inTableBody = false;
        break;

      case "tr_open":
        currentRow = [];
        break;

      case "tr_close":
        if (inTableBody) tableRows.push([...currentRow]);
        currentRow = [];
        break;

      case "th_open":
      case "td_open":
        break;

      case "th_close":
      case "td_close":
        break;

      default:
        break;
    }

    // Bullet / ordered list items — look for inline child
    if (tok.type === "list_item_open") {
      // gather inline content of this list item
      let itemText = "";
      let j = i + 1;
      while (j < tokens.length && tokens[j].type !== "list_item_close") {
        if (tokens[j].type === "inline") {
          itemText = tokens[j].content
            .replace(/\*\*([^*]+)\*\*/g, "$1")
            .replace(/\*([^*]+)\*/g, "$1")
            .replace(/`([^`]+)`/g, "$1")
            .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
        }
        j++;
      }
      i = j; // skip to list_item_close

      if (itemText.trim()) {
        ensureRoom(16);
        const indent = MARGIN + (bulletLevel - 1) * 14;
        const bullet = inOrderedList ? `${++orderedIndex}.` : "•";
        const bulletX = indent;
        const textX = indent + 14;

        doc.font("Helvetica").fontSize(10.5).fillColor(inOrderedList ? ACCENT_PDF : ACCENT_PDF)
          .text(bullet, bulletX, doc.y, { width: 12, lineBreak: false });
        doc.font("Helvetica").fontSize(10.5).fillColor(TEXT)
          .text(itemText.trim(), textX, doc.y, { width: CONTENT - (textX - MARGIN), lineGap: 1 });
        gap(2);
      }
    }
  }

  // ─── page numbers ─────────────────────────────────────────────────────────
  const totalPages = doc.bufferedPageRange().count;
  for (let p = 0; p < totalPages; p++) {
    doc.switchToPage(p);
    doc.font("Helvetica").fontSize(8).fillColor(MUTED_PDF)
      .text(`${p + 1} / ${totalPages}`, MARGIN, HEIGHT - 30, {
        width: CONTENT,
        align: "right",
        lineBreak: false,
      });
  }

  doc.end();
  return new Promise<void>((resolve) => out.on("finish", resolve));
}

async function main() {
  const files = [
    { input: "pulse-user-guide.md",      output: "pulse-user-guide.pdf" },
    { input: "pulse-technical-docs.md",  output: "pulse-technical-docs.pdf" },
  ];

  for (const { input, output } of files) {
    const inputPath  = path.join(ROOT, input);
    const outputPath = path.join(ROOT, output);
    if (!fs.existsSync(inputPath)) {
      console.error(`Not found: ${inputPath}`);
      continue;
    }
    process.stdout.write(`Generating ${output} … `);
    await makePdf(inputPath, outputPath);
    const size = (fs.statSync(outputPath).size / 1024).toFixed(0);
    console.log(`done (${size} KB)`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
