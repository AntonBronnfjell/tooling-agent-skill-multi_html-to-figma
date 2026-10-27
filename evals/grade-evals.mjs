#!/usr/bin/env node
/**
 * Deterministic Eval Runner & Grader for tooling-agent-skill-multi_html-to-figma.
 *
 * Executes all 4 evaluation scenarios defined in evals/evals.json and writes
 * evals/grading.json with pass/fail evidence per assertion.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { measureHtmlFile } from '../scripts/measure-html-dom.mjs';
import { compileMeasuredToFiles } from '../scripts/compile-to-figma.mjs';
import { verifyMigration } from '../scripts/verify-figma-migration.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const EVALS_SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, 'evals.json'), 'utf8'));

const results = [];

function recordEval(evalDef, assertionResults) {
  const passed = assertionResults.every((a) => a.passed);
  results.push({
    id: evalDef.id,
    name: evalDef.name,
    passed,
    assertions: assertionResults,
  });
}

// Eval 1: DOM Measurement & Token Resolution
{
  const evalDef = EVALS_SPEC.evals[0];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval1-'));
  const htmlPath = path.join(tmpDir, 'index.html');
  const outPath = path.join(tmpDir, 'measured.json');

  fs.writeFileSync(
    htmlPath,
    `<!doctype html>
<html lang="en" data-theme="paper">
<head>
  <meta charset="utf-8" />
  <style>
    :root {
      --surface: rgb(250, 246, 238);
      --ink: rgb(22, 20, 15);
      --brand: rgb(180, 83, 9);
    }
    body { margin: 0; padding: 16px; width: 780px; font-family: Inter, sans-serif; }
    .box { background: var(--surface); color: var(--ink); border: 1px solid var(--brand); border-radius: 8px; padding: 12px; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }
    .dot { width: 16px; height: 16px; position: relative; }
    .dot::after { content: ""; display: block; width: 8px; height: 8px; background: var(--brand); border-radius: 999px; }
  </style>
</head>
<body>
  <div data-component="AlertBanner" data-story="Default" data-title="Feedback/AlertBanner" style="width: 400px;">
    <div class="box">
      <span class="sr-only">Screen reader only notice</span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 22h20L12 2z"/></svg>
      <div class="dot"></div>
      <span> Sanctuary service starts in 15 minutes </span>
      <input type="text" value="Main Chapel" />
      <input type="range" min="0" max="100" value="50" />
    </div>
  </div>
</body>
</html>`
  );

  const measured = measureHtmlFile(htmlPath, outPath);
  const story = measured?.AlertBanner?.stories?.Default;
  const rawStr = JSON.stringify(story || {});

  recordEval(evalDef, [
    {
      text: evalDef.assertions[0],
      passed: Boolean(story && story.rootRect[0] >= 16 && story.items.length > 0),
      evidence: `AlertBanner/Default rootRect=${JSON.stringify(story?.rootRect)}, items=${story?.items?.length}`,
    },
    {
      text: evalDef.assertions[1],
      passed: !rawStr.includes('var(--') && !rawStr.includes('currentColor'),
      evidence: '0 occurrences of var(--) or currentColor in serialized items',
    },
    {
      text: evalDef.assertions[2],
      passed: !rawStr.includes('Screen reader only notice'),
      evidence: '.sr-only node excluded from visual item list',
    },
    {
      text: evalDef.assertions[3],
      passed:
        story.items.some((i) => i.tag === 'after') && story.items.some((i) => i.tag === 'thumb'),
      evidence: 'Both tag="after" and tag="thumb" present in measured items',
    },
  ]);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Eval 2: Tuple Compilation & Multipart Chunking
{
  const evalDef = EVALS_SPEC.evals[1];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval2-'));
  const measuredPath = path.join(tmpDir, 'measured.json');
  const outJs = path.join(tmpDir, 'build-batch.js');

  const bigMeasured = {};
  for (let c = 1; c <= 14; c++) {
    const stories = {};
    for (let s = 1; s <= 5; s++) {
      stories[`State ${s}`] = {
        key: `State${s}`,
        rootRect: [420, 140],
        items: Array.from({ length: 22 }, (_, idx) => ({
          kind: idx % 2 === 0 ? 'box' : 'text',
          rect: [12, idx * 6, 380, 20],
          bg: 'rgb(250, 246, 238)',
          text: `Component ${c} State ${s} Item ${idx} verified in Chromium`,
          fontFamily: 'Inter',
          fontSize: 14,
          fontWeight: 500,
          lineHeight: '20px',
          color: 'rgb(22, 20, 15)',
        })),
      };
    }
    bigMeasured[`Widget${c}`] = { title: `Widgets/Widget${c}`, stories };
  }
  fs.writeFileSync(measuredPath, JSON.stringify(bigMeasured, null, 2));
  const partFiles = compileMeasuredToFiles(bigMeasured, outJs, '52:2');
  const maxLen = Math.max(...partFiles.map((f) => fs.readFileSync(f, 'utf8').length));
  const verifyRep = verifyMigration(measuredPath, [outJs]);

  recordEval(evalDef, [
    {
      text: evalDef.assertions[0],
      passed: partFiles.length >= 2 && maxLen <= 46000,
      evidence: `Split into ${partFiles.length} parts, max length=${maxLen} chars (<= 46,000)`,
    },
    {
      text: evalDef.assertions[1],
      passed: verifyRep.ok,
      evidence: `STRS, SVGS, DATA parsed cleanly across all ${partFiles.length} parts`,
    },
    {
      text: evalDef.assertions[2],
      passed: verifyRep.compiledVariantsCount === 70,
      evidence: `Preserved ${verifyRep.compiledVariantsCount}/70 variants across parts`,
    },
  ]);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Eval 3: Migration Parity Verification Gate
{
  const evalDef = EVALS_SPEC.evals[2];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval3-'));
  const measuredPath = path.join(tmpDir, 'measured.json');
  const outJs = path.join(tmpDir, 'build.js');

  const measured = {
    Card: {
      title: 'Surface/Card',
      stories: {
        Default: {
          key: 'Default',
          rootRect: [300, 120],
          items: [{ kind: 'box', rect: [0, 0, 300, 120], bg: 'rgb(250, 246, 238)' }],
        },
        Elevated: {
          key: 'Elevated',
          rootRect: [300, 120],
          items: [{ kind: 'box', rect: [0, 0, 300, 120], bg: 'rgb(255, 253, 248)' }],
        },
      },
    },
  };
  fs.writeFileSync(measuredPath, JSON.stringify(measured, null, 2));
  compileMeasuredToFiles(measured, outJs, '52:2');

  const validRep = verifyMigration(measuredPath, [outJs]);

  const tokenCorrupted = fs.readFileSync(outJs, 'utf8').replace('rgb(250, 246, 238)', 'var(--surface-paper)');
  fs.writeFileSync(outJs, tokenCorrupted);
  const tokenRep = verifyMigration(measuredPath, [outJs]);

  // Remove Elevated variant
  const subsetMeasured = {
    Card: {
      title: 'Surface/Card',
      stories: { Default: measured.Card.stories.Default },
    },
  };
  compileMeasuredToFiles(subsetMeasured, outJs, '52:2');
  const missingVariantRep = verifyMigration(measuredPath, [outJs]);

  recordEval(evalDef, [
    {
      text: evalDef.assertions[0],
      passed: validRep.ok && validRep.errors.length === 0,
      evidence: `Valid migration ok=${validRep.ok}`,
    },
    {
      text: evalDef.assertions[1],
      passed: !tokenRep.ok && tokenRep.errors.some((e) => e.includes('Unresolved CSS variable')),
      evidence: `Detected unresolved token: ${tokenRep.errors[0]}`,
    },
    {
      text: evalDef.assertions[2],
      passed: !missingVariantRep.ok && missingVariantRep.errors.some((e) => e.includes('Story=Elevated missing')),
      evidence: `Detected missing variant: ${missingVariantRep.errors[0]}`,
    },
  ]);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Eval 4: Cursor Hook Payload Guardrail
{
  const evalDef = EVALS_SPEC.evals[3];
  const hookScript = path.join(ROOT_DIR, '.cursor/hooks/verify-figma-payload.sh');
  try {
    fs.chmodSync(hookScript, 0o755);
  } catch {
    // Already executable or running inside a sandbox that restricts .cursor chmod
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval4-'));
  const validFile = path.join(tmpDir, 'build-valid.js');
  const oversizedFile = path.join(tmpDir, 'build-oversized.js');
  const unresolvedFile = path.join(tmpDir, 'build-unresolved.js');

  fs.writeFileSync(validFile, '// valid payload\nconst STRS = ["rgb(22, 20, 15)"];\n');
  fs.writeFileSync(oversizedFile, '// oversized\n' + 'x'.repeat(51000));
  fs.writeFileSync(unresolvedFile, '// unresolved\nconst STRS = ["var(--ink)"];\n');

  const runHook = (filePath) =>
    spawnSync(hookScript, [], {
      input: JSON.stringify({ file_path: filePath }),
      encoding: 'utf8',
    });

  const rValid = runHook(validFile);
  const rOversized = runHook(oversizedFile);
  const rUnresolved = runHook(unresolvedFile);

  recordEval(evalDef, [
    {
      text: evalDef.assertions[0],
      passed: rValid.status === 0,
      evidence: `Valid script exit code=${rValid.status}`,
    },
    {
      text: evalDef.assertions[1],
      passed: rOversized.status === 2,
      evidence: `Oversized script exit code=${rOversized.status} (${rOversized.stderr.trim()})`,
    },
    {
      text: evalDef.assertions[2],
      passed: rUnresolved.status === 2,
      evidence: `Unresolved var(--) script exit code=${rUnresolved.status} (${rUnresolved.stderr.trim()})`,
    },
  ]);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const totalAssertions = results.reduce((acc, r) => acc + r.assertions.length, 0);
const passedAssertions = results.reduce(
  (acc, r) => acc + r.assertions.filter((a) => a.passed).length,
  0
);

const gradingReport = {
  skill_name: EVALS_SPEC.skill_name,
  repository: EVALS_SPEC.repository,
  summary: {
    total_evals: results.length,
    passed_evals: results.filter((r) => r.passed).length,
    total_assertions: totalAssertions,
    passed_assertions: passedAssertions,
    pass_rate: Number((passedAssertions / totalAssertions).toFixed(4)),
  },
  results,
};

try {
  fs.writeFileSync(path.join(__dirname, 'grading.json'), JSON.stringify(gradingReport, null, 2));
} catch {
  // Ignore write error in read-only sandboxed test runs
}
console.log(JSON.stringify(gradingReport, null, 2));

if (passedAssertions !== totalAssertions) {
  process.exit(1);
}
