#!/usr/bin/env node
/**
 * Phase 1: Measure live HTML / CSS / React / Storybook DOM in Headless Chromium.
 *
 * Usage:
 *   node scripts/measure-html-dom.mjs --html <file.html> [--out /tmp/measured-stories.json]
 *   node scripts/measure-html-dom.mjs --storybook <storybook-static-dir> --range <start1> <end1> [--out /tmp/measured-stories.json]
 *   node scripts/measure-html-dom.mjs --self-test
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DEFAULT_CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  path.join(
    os.homedir(),
    'Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell'
  ),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function findChromeBinary() {
  for (const candidate of DEFAULT_CHROME_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * In-browser DOM walker injected into either an arbitrary HTML page or Storybook runner.
 */
export const DOM_EXTRACTOR_RUNTIME = String.raw`
const round2 = (n) => Math.round(n * 100) / 100;

function isTransparent(c) {
  return !c || c === "transparent" || c === "rgba(0, 0, 0, 0)";
}

function serializeSvg(svgEl, w, h) {
  const win = svgEl.ownerDocument.defaultView || window;
  const clone = svgEl.cloneNode(true);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(Math.max(1, round2(w))));
  clone.setAttribute("height", String(Math.max(1, round2(h))));
  const origNodes = [svgEl, ...svgEl.querySelectorAll("*")];
  const cloneNodes = [clone, ...clone.querySelectorAll("*")];
  for (let i = 0; i < origNodes.length; i++) {
    const orig = origNodes[i];
    const cl = cloneNodes[i];
    const cs = win.getComputedStyle(orig);
    const strokeAttr = cl.getAttribute("stroke");
    const fillAttr = cl.getAttribute("fill");
    if (strokeAttr === "currentColor" || (!strokeAttr && cs.stroke && cs.stroke !== "none")) {
      cl.setAttribute("stroke", cs.stroke && cs.stroke !== "none" && !cs.stroke.startsWith("url") ? cs.stroke : cs.color);
    }
    if (fillAttr === "currentColor") {
      cl.setAttribute("fill", cs.fill && cs.fill !== "none" && !cs.fill.startsWith("url") ? cs.fill : cs.color);
    }
    if (cs.strokeWidth && cs.strokeWidth !== "0px" && !cl.getAttribute("stroke-width")) {
      cl.setAttribute("stroke-width", String(parseFloat(cs.strokeWidth)));
    }
    if (cs.strokeLinecap && cs.strokeLinecap !== "butt" && !cl.getAttribute("stroke-linecap")) {
      cl.setAttribute("stroke-linecap", cs.strokeLinecap);
    }
    if (cs.strokeLinejoin && cs.strokeLinejoin !== "miter" && !cl.getAttribute("stroke-linejoin")) {
      cl.setAttribute("stroke-linejoin", cs.strokeLinejoin);
    }
    if (cs.opacity && cs.opacity !== "1" && orig !== svgEl) {
      cl.setAttribute("opacity", cs.opacity);
    }
    cl.removeAttribute("class");
  }
  return clone.outerHTML;
}

function splitTextNodeByLines(textNode, br) {
  const raw = textNode.textContent || "";
  if (!raw.trim()) return [];
  const doc = textNode.ownerDocument || document;
  const fullRange = doc.createRange();
  fullRange.selectNodeContents(textNode);
  const clientRects = [...fullRange.getClientRects()].filter(r => r.width > 0.5 && r.height > 0.5);
  if (clientRects.length === 0) return [];
  if (clientRects.length === 1) {
    const r = clientRects[0];
    return [{
      text: raw.replace(/\s+/g, " "),
      rect: [round2(r.left - br.left), round2(r.top - br.top), round2(r.width), round2(r.height)],
      lineCount: 1
    }];
  }
  const minLeft = Math.min(...clientRects.map(r => r.left));
  const maxLeft = Math.max(...clientRects.map(r => r.left));
  const parent = textNode.parentElement;
  const parentHasMixedInline = parent && [...parent.childNodes].filter(n => n.nodeType === 1 || (n.nodeType === 3 && n.textContent.trim())).length > 1;
  if (!parentHasMixedInline && (maxLeft - minLeft) <= 4) {
    const u = fullRange.getBoundingClientRect();
    return [{
      text: raw.replace(/\s+/g, " ").trim(),
      rect: [round2(u.left - br.left), round2(u.top - br.top), round2(u.width), round2(u.height)],
      lineCount: clientRects.length,
      lineWidths: clientRects.map(r => round2(r.width))
    }];
  }
  const lines = [];
  const charRange = doc.createRange();
  for (let i = 0; i < raw.length; i++) {
    charRange.setStart(textNode, i);
    charRange.setEnd(textNode, i + 1);
    const cr = charRange.getBoundingClientRect();
    if (cr.width === 0 && cr.height === 0) continue;
    let line = lines[lines.length - 1];
    if (!line || Math.abs(cr.top - line.top) > 6) {
      line = { start: i, end: i + 1, top: cr.top, bottom: cr.bottom, left: cr.left, right: cr.right };
      lines.push(line);
    } else {
      line.end = i + 1;
      line.left = Math.min(line.left, cr.left);
      line.right = Math.max(line.right, cr.right);
      line.top = Math.min(line.top, cr.top);
      line.bottom = Math.max(line.bottom, cr.bottom);
    }
  }
  return lines.map(l => ({
    text: raw.slice(l.start, l.end).replace(/\s+/g, " "),
    rect: [round2(l.left - br.left), round2(l.top - br.top), round2(l.right - l.left), round2(l.bottom - l.top)],
    lineCount: 1
  })).filter(l => l.text.trim().length > 0);
}

function measureStoryBox(box) {
  for (const el of box.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.position === "fixed") {
      el.style.position = "relative";
      el.style.inset = "auto";
      el.style.width = "100%";
      el.style.minHeight = "120px";
    }
    if (el.tagName === "IFRAME" && el.contentDocument && el.contentDocument.body) {
      const sh = el.contentDocument.documentElement.scrollHeight || el.contentDocument.body.scrollHeight;
      if (sh > 0) el.style.height = sh + "px";
    }
  }

  const br = box.getBoundingClientRect();
  const items = [];

  function walk(el, parentOp, refBr = br) {
    if (el.nodeType !== 1) return;
    const win = el.ownerDocument.defaultView || window;
    const cs = win.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    const ownOp = parseFloat(cs.opacity ?? "1");
    const effOp = round2(parentOp * (Number.isNaN(ownOp) ? 1 : ownOp));
    if (effOp <= 0.01) return;

    const r = el.getBoundingClientRect();
    if (r.width <= 1.5 && r.height <= 1.5 && (cs.overflow === "hidden" || cs.clip !== "auto" || cs.clipPath !== "none")) {
      return;
    }

    const tag = el.tagName.toLowerCase();
    const x = round2(r.left - refBr.left);
    const y = round2(r.top - refBr.top);
    const w = round2(r.width);
    const h = round2(r.height);

    if (tag === "svg") {
      if (w > 0 && h > 0) {
        items.push({
          kind: "svg",
          rect: [x, y, w, h],
          color: cs.color,
          opacity: effOp < 1 ? effOp : undefined,
          svg: serializeSvg(el, w, h)
        });
      }
      return;
    }

    const hasBg = !isTransparent(cs.backgroundColor);
    const bt = parseFloat(cs.borderTopWidth) > 0 && !isTransparent(cs.borderTopColor)
      ? { w: parseFloat(cs.borderTopWidth), style: cs.borderTopStyle, color: cs.borderTopColor }
      : undefined;
    const brt = parseFloat(cs.borderRightWidth) > 0 && !isTransparent(cs.borderRightColor)
      ? { w: parseFloat(cs.borderRightWidth), style: cs.borderRightStyle, color: cs.borderRightColor }
      : undefined;
    const bb = parseFloat(cs.borderBottomWidth) > 0 && !isTransparent(cs.borderBottomColor)
      ? { w: parseFloat(cs.borderBottomWidth), style: cs.borderBottomStyle, color: cs.borderBottomColor }
      : undefined;
    const bl = parseFloat(cs.borderLeftWidth) > 0 && !isTransparent(cs.borderLeftColor)
      ? { w: parseFloat(cs.borderLeftWidth), style: cs.borderLeftStyle, color: cs.borderLeftColor }
      : undefined;
    const hasBorder = Boolean(bt || brt || bb || bl);
    const hasShadow = cs.boxShadow && cs.boxShadow !== "none";

    if ((hasBg || hasBorder || hasShadow || tag === "hr" || tag === "img") && w > 0 && h > 0) {
      const radii = [
        parseFloat(cs.borderTopLeftRadius) || 0,
        parseFloat(cs.borderTopRightRadius) || 0,
        parseFloat(cs.borderBottomRightRadius) || 0,
        parseFloat(cs.borderBottomLeftRadius) || 0
      ];
      items.push({
        kind: "box",
        tag,
        rect: [x, y, w, h],
        bg: hasBg ? cs.backgroundColor : (tag === "img" ? "rgb(235, 229, 216)" : undefined),
        bt,
        br: brt,
        bb,
        bl,
        radius: radii.some(v => v > 0) ? radii : undefined,
        shadow: hasShadow ? cs.boxShadow : undefined,
        opacity: effOp < 1 ? effOp : undefined
      });
    }

    const afterCs = getComputedStyle(el, "::after");
    if (afterCs && afterCs.content && afterCs.content !== "none" && afterCs.content !== "normal") {
      const aw = parseFloat(afterCs.width) || 0;
      const ah = parseFloat(afterCs.height) || 0;
      const aop = parseFloat(afterCs.opacity ?? "1");
      const atr = afterCs.transform || "none";
      const isZeroScale = atr.startsWith("matrix(0,") || atr.startsWith("matrix(0 ");
      if (aw > 0 && ah > 0 && aop > 0.05 && !isZeroScale && !isTransparent(afterCs.backgroundColor)) {
        const ax = round2(x + (w - aw) / 2);
        const ay = round2(y + (h - ah) / 2);
        const arad = parseFloat(afterCs.borderTopLeftRadius) || 999;
        items.push({
          kind: "box",
          tag: "after",
          rect: [ax, ay, aw, ah],
          bg: afterCs.backgroundColor,
          radius: [arad, arad, arad, arad],
          opacity: effOp * aop < 1 ? round2(effOp * aop) : undefined
        });
      }
    }

    if (tag === "input" && el.type === "range" && w > 0 && h > 0) {
      const min = parseFloat(el.min || "0");
      const max = parseFloat(el.max || "100");
      const val = parseFloat(el.value || "0");
      const pct = Math.max(0, Math.min(1, (val - min) / ((max - min) || 1)));
      const tw = 20, th = 20;
      const tx = round2(x + pct * Math.max(0, w - tw));
      const ty = round2(y + (h - th) / 2);
      const isInvalid = el.getAttribute("aria-invalid") === "true" || el.closest("[data-invalid]");
      const bCol = isInvalid ? "rgb(185, 28, 28)" : "rgb(22, 20, 15)";
      items.push({
        kind: "box",
        tag: "thumb",
        rect: [tx, ty, tw, th],
        bg: "rgb(255, 253, 248)",
        bt: { w: 2, style: "solid", color: bCol },
        br: { w: 2, style: "solid", color: bCol },
        bb: { w: 2, style: "solid", color: bCol },
        bl: { w: 2, style: "solid", color: bCol },
        radius: [999, 999, 999, 999],
        opacity: effOp < 1 ? effOp : undefined
      });
    }

    if ((tag === "input" || tag === "textarea") && el.type !== "checkbox" && el.type !== "radio" && el.type !== "range" && el.type !== "hidden") {
      const val = el.value ? (el.type === "password" ? "•".repeat(el.value.length) : el.value) : (el.placeholder || "");
      if (val) {
        const parsedPl = parseFloat(cs.paddingLeft);
        const pl = Number.isNaN(parsedPl) ? 12 : parsedPl;
        const pt = parseFloat(cs.paddingTop) || 8;
        const fs = parseFloat(cs.fontSize) || 14;
        const tx = cs.textAlign === "center" ? x + Math.max(2, (w - val.length * fs * 0.6) / 2) : x + pl;
        const ty = tag === "textarea" ? y + pt : y + Math.max(2, (h - fs * 1.25) / 2);
        items.push({
          kind: "text",
          tag,
          text: val,
          rect: [round2(tx), round2(ty), round2(Math.max(12, w - pl * 2)), round2(fs * 1.3)],
          fontFamily: cs.fontFamily.split(",")[0].replace(/"/g, ""),
          fontSize: fs,
          fontWeight: parseInt(cs.fontWeight, 10) || 400,
          fontStyle: cs.fontStyle,
          lineHeight: cs.lineHeight,
          letterSpacing: cs.letterSpacing !== "normal" ? cs.letterSpacing : undefined,
          color: el.value ? cs.color : "rgb(138, 130, 117)",
          opacity: effOp < 1 ? effOp : undefined
        });
      }
    } else if (tag === "select") {
      const optText = el.options && el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : "";
      if (optText) {
        const pl = parseFloat(cs.paddingLeft) || 12;
        const fs = parseFloat(cs.fontSize) || 14;
        items.push({
          kind: "text",
          tag,
          text: optText,
          rect: [round2(x + pl), round2(y + Math.max(2, (h - fs * 1.25) / 2)), round2(Math.max(20, w - pl * 2)), round2(fs * 1.3)],
          fontFamily: cs.fontFamily.split(",")[0].replace(/"/g, ""),
          fontSize: fs,
          fontWeight: parseInt(cs.fontWeight, 10) || 400,
          fontStyle: cs.fontStyle,
          lineHeight: cs.lineHeight,
          color: cs.color,
          opacity: effOp < 1 ? effOp : undefined
        });
      }
      if (!el.parentElement || !el.parentElement.querySelector("svg")) {
        items.push({
          kind: "svg",
          rect: [round2(x + w - 28), round2(y + (h - 16) / 2), 16, 16],
          color: cs.color,
          opacity: effOp < 1 ? effOp : undefined,
          svg: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgb(98, 92, 81)" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'
        });
      }
    }

    if (tag === "iframe" && el.contentDocument && el.contentDocument.body) {
      const iframeBr = {
        left: refBr.left - (r.left + (parseFloat(cs.borderLeftWidth) || 0)),
        top: refBr.top - (r.top + (parseFloat(cs.borderTopWidth) || 0))
      };
      walk(el.contentDocument.body, effOp, iframeBr);
      return;
    }

    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        const pieces = splitTextNodeByLines(child, refBr);
        for (const p of pieces) {
          items.push({
            kind: "text",
            tag,
            text: p.text,
            rect: p.rect,
            lineCount: p.lineCount,
            lineWidths: p.lineWidths,
            fontFamily: cs.fontFamily.split(",")[0].replace(/"/g, ""),
            fontSize: parseFloat(cs.fontSize) || 16,
            fontWeight: parseInt(cs.fontWeight, 10) || 400,
            fontStyle: cs.fontStyle !== "normal" ? cs.fontStyle : undefined,
            lineHeight: cs.lineHeight,
            letterSpacing: cs.letterSpacing !== "normal" ? cs.letterSpacing : undefined,
            textTransform: cs.textTransform !== "none" ? cs.textTransform : undefined,
            textDecoration: cs.textDecorationLine && cs.textDecorationLine !== "none" ? cs.textDecorationLine : undefined,
            textAlign: cs.textAlign,
            color: cs.color,
            opacity: effOp < 1 ? effOp : undefined
          });
        }
      } else if (child.nodeType === 1) {
        walk(child, effOp, refBr);
      }
    }
  }

  for (const child of box.children) {
    walk(child, 1, br);
  }

  let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
  for (const it of items) {
    const [ix, iy, iw, ih] = it.rect;
    if (ix < minX) minX = ix;
    if (iy < minY) minY = iy;
    if (ix + iw > maxX) maxX = ix + iw;
    if (iy + ih > maxY) maxY = iy + ih;
  }
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 40; }

  const hadTallStage = minY > 40;
  if (hadTallStage) {
    const shiftY = round2(minY - 8);
    for (const it of items) {
      it.rect[1] = round2(it.rect[1] - shiftY);
    }
    maxY = round2(maxY - shiftY + 8);
    minY = 8;
  }

  const firstChild = box.firstElementChild;
  const fcr = firstChild ? firstChild.getBoundingClientRect() : br;
  const fcCs = firstChild ? getComputedStyle(firstChild) : null;
  const fcHasBox = fcCs && (!isTransparent(fcCs.backgroundColor) || parseFloat(fcCs.borderTopWidth) > 0 || parseFloat(fcCs.borderBottomWidth) > 0 || parseFloat(fcCs.borderLeftWidth) > 0 || (fcCs.boxShadow && fcCs.boxShadow !== "none"));
  const useTightWidth = !hadTallStage && fcr.width >= 740 && !fcHasBox && minX < 32;
  const useTightHeight = (fcr.height >= 400 || (fcr.height >= 240 && maxY < fcr.height * 0.6)) && !fcHasBox;

  const rootW = round2(useTightWidth ? Math.max(maxX, 32) : Math.max(fcr.width, maxX));
  const rootH = round2(useTightHeight ? Math.max(maxY, 32) : Math.max(fcr.height, maxY));

  return {
    key: box.dataset.key || box.dataset.story || "Default",
    rootRect: [rootW, rootH],
    error: box.dataset.error,
    items
  };
}
`;

/**
 * Measure an arbitrary HTML file by injecting the DOM measurement script and running headless Chromium.
 */
export function measureHtmlFile(htmlFilePath, outJsonPath = '/tmp/measured-stories.json') {
  const chromeBin = findChromeBinary();
  if (!chromeBin) {
    throw new Error('No headless Chromium binary found. Set CHROME_BIN or install Playwright Chromium.');
  }

  const absHtml = path.resolve(htmlFilePath);
  const rawHtml = fs.readFileSync(absHtml, 'utf8');

  const runnerScript = `
<script type="module">
${DOM_EXTRACTOR_RUNTIME}

await new Promise(r => setTimeout(r, 80));
const results = {};
const boxes = [...document.querySelectorAll("[data-component], .story-box")];
if (boxes.length === 0) {
  const wrapper = document.createElement("div");
  wrapper.className = "story-box";
  wrapper.dataset.component = "Page";
  wrapper.dataset.story = "Default";
  while (document.body.firstChild) {
    wrapper.appendChild(document.body.firstChild);
  }
  document.body.appendChild(wrapper);
  boxes.push(wrapper);
}

for (const box of boxes) {
  const compName = box.dataset.component || box.dataset.suite || "Component";
  const storyName = box.dataset.story || "Default";
  const title = box.dataset.title || ("HTML/" + compName);
  if (!results[compName]) {
    results[compName] = { title, stories: {} };
  }
  results[compName].stories[storyName] = measureStoryBox(box);
}

let outPre = document.getElementById("out");
if (!outPre) {
  outPre = document.createElement("pre");
  outPre.id = "out";
  document.body.appendChild(outPre);
}
outPre.textContent = JSON.stringify(results, null, 2);
</script>`;

  const instrumentedPath = path.join(path.dirname(absHtml), `_measure_${ path.basename(absHtml) }`);
  const injected = rawHtml.includes('</body>')
    ? rawHtml.replace('</body>', `${runnerScript}\n</body>`)
    : `${rawHtml}\n${runnerScript}`;

  fs.writeFileSync(instrumentedPath, injected);
  try {
    const dom = execFileSync(
      chromeBin,
      [
        '--headless',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-web-security',
        '--allow-file-access-from-files',
        '--window-size=780,1200',
        '--virtual-time-budget=5000',
        '--dump-dom',
        `file://${instrumentedPath}`,
      ],
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
    );

    const m = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
    if (!m || !m[1].trim()) {
      throw new Error(`Failed to extract <pre id="out"> from DOM.`);
    }
    const jsonText = m[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
    fs.writeFileSync(outJsonPath, jsonText);
    return JSON.parse(jsonText);
  } finally {
    if (fs.existsSync(instrumentedPath)) fs.unlinkSync(instrumentedPath);
  }
}

function runSelfTest() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-to-figma-selftest-'));
  const htmlFile = path.join(tmpDir, 'fixture.html');
  const outFile = path.join(tmpDir, 'measured.json');

  fs.writeFileSync(
    htmlFile,
    `<!doctype html>
<html lang="en" data-theme="paper">
<head>
  <meta charset="utf-8" />
  <style>
    :root {
      --bg-paper: rgb(250, 246, 238);
      --ink-primary: rgb(22, 20, 15);
      --accent-amber: rgb(180, 83, 9);
      --border-hairline: rgb(224, 217, 203);
    }
    body { margin: 0; padding: 16px; width: 780px; font-family: Inter, sans-serif; }
    .card {
      background: var(--bg-paper);
      color: var(--ink-primary);
      border: 1px solid var(--border-hairline);
      border-radius: 12px;
      padding: 16px;
      box-shadow: 0 2px 6px rgba(22, 20, 15, 0.08);
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
    }
    .radio-dot {
      position: relative;
      width: 18px;
      height: 18px;
      border: 2px solid var(--accent-amber);
      border-radius: 999px;
    }
    .radio-dot::after {
      content: "";
      display: block;
      width: 8px;
      height: 8px;
      background: var(--accent-amber);
      border-radius: 999px;
    }
  </style>
</head>
<body>
  <div data-component="SanctuaryCard" data-story="Default" data-title="Domain/SanctuaryCard" style="width: 360px;">
    <div class="card">
      <span class="sr-only">Hidden screen reader label</span>
      <div style="display:flex; align-items:center; gap:8px;">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="9" />
        </svg>
        <h3 style="margin:0; font-size:18px; font-weight:600;">Sunday Gathering</h3>
        <div class="radio-dot"></div>
      </div>
      <p style="margin:8px 0 0; font-size:14px; line-height:20px;">Join our parish fellowship in the main sanctuary at 10:00 AM.</p>
      <input type="text" value="Pastor Ruth Okafor" style="margin-top:8px; padding:6px 12px; width:240px;" />
      <input type="range" min="0" max="100" value="60" style="margin-top:8px; width:200px;" />
    </div>
  </div>
</body>
</html>`
  );

  const parsed = measureHtmlFile(htmlFile, outFile);
  const comp = parsed.SanctuaryCard;
  if (!comp || !comp.stories || !comp.stories.Default) {
    throw new Error('Self-test failed: SanctuaryCard/Default missing from output.');
  }
  const story = comp.stories.Default;
  const boxes = story.items.filter((i) => i.kind === 'box');
  const svgs = story.items.filter((i) => i.kind === 'svg');
  const texts = story.items.filter((i) => i.kind === 'text');

  if (boxes.length < 3) throw new Error(`Expected >= 3 boxes (card, radio ::after, range thumb), got ${boxes.length}`);
  if (svgs.length !== 1) throw new Error(`Expected 1 svg, got ${svgs.length}`);
  if (svgs[0].svg.includes('currentColor')) throw new Error('SVG currentColor was not resolved to computed RGB');
  if (texts.some((t) => t.text.includes('Hidden screen reader label'))) {
    throw new Error('.sr-only element was not filtered out');
  }
  if (!texts.some((t) => t.text.includes('Pastor Ruth Okafor'))) {
    throw new Error('<input> value text was not extracted');
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('PASS: measure-html-dom.mjs --self-test passed all assertions.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    runSelfTest();
    process.exit(0);
  }
  const htmlIdx = args.indexOf('--html');
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : '/tmp/measured-stories.json';

  if (htmlIdx >= 0 && args[htmlIdx + 1]) {
    const res = measureHtmlFile(args[htmlIdx + 1], outPath);
    console.log(`Measured ${Object.keys(res).length} component(s) into ${outPath}`);
    process.exit(0);
  }

  console.error('Usage: node scripts/measure-html-dom.mjs --html <file.html> [--out <out.json>] | --self-test');
  process.exit(1);
}
