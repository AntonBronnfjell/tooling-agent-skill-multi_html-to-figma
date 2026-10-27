#!/usr/bin/env node
/**
 * Phase 4: Verify DOM-to-Figma migration completeness, payload limits, and token resolution.
 *
 * Usage:
 *   node scripts/verify-figma-migration.mjs --measured <measured.json> --scripts <build.js> [...]
 *   node scripts/verify-figma-migration.mjs --self-test
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileMeasuredToFiles } from './compile-to-figma.mjs';

export function collectScriptParts(basePaths) {
  const all = [];
  for (const bp of basePaths) {
    if (fs.existsSync(bp)) all.push(bp);
    for (let p = 2; p <= 50; p++) {
      const part = bp.replace(/\.js$/, `.part${p}.js`);
      if (part !== bp && fs.existsSync(part)) {
        all.push(part);
      } else {
        break;
      }
    }
  }
  return [...new Set(all)];
}

export function verifyMigration(measuredPath, baseScriptPaths) {
  const errors = [];
  const measured = JSON.parse(fs.readFileSync(measuredPath, 'utf8'));
  const scriptFiles = collectScriptParts(baseScriptPaths);

  if (scriptFiles.length === 0) {
    errors.push('No compiled script files found.');
  }

  const expectedVariants = new Map();
  let totalExpectedVariants = 0;

  for (const [compName, compData] of Object.entries(measured)) {
    if (compData.importError) {
      errors.push(`Component ${compName} has importError: ${compData.importError}`);
      continue;
    }
    const storySet = new Set();
    for (const [sName, sData] of Object.entries(compData.stories || {})) {
      if (sData.error) {
        errors.push(`Story ${compName}/${sName} has runtime error: ${sData.error}`);
      }
      const [rw, rh] = sData.rootRect || [0, 0];
      if (rw < 16 || rh < 16) {
        errors.push(`Story ${compName}/${sName} has invalid rootRect [${rw}, ${rh}] (< 16px).`);
      }
      if (!Array.isArray(sData.items) || sData.items.length === 0) {
        errors.push(`Story ${compName}/${sName} has 0 measured items.`);
      }
      storySet.add(sName);
      totalExpectedVariants++;
    }
    expectedVariants.set(compName, storySet);
  }

  const compiledVariants = new Map();
  let totalCompiledVariants = 0;

  for (const sf of scriptFiles) {
    const code = fs.readFileSync(sf, 'utf8');
    if (code.length > 50000) {
      errors.push(`Script ${sf} length (${code.length} chars) exceeds 50,000-char use_figma limit.`);
    }

    const strsMatch = code.match(/const STRS = (\[[\s\S]*?\]);\nconst SVGS =/);
    const svgsMatch = code.match(/const SVGS = (\[[\s\S]*?\]);\nconst DATA =/);
    const dataMatch = code.match(/const DATA = (\{[\s\S]*?\});\n\nfunction parseColor/);

    if (!strsMatch || !svgsMatch || !dataMatch) {
      errors.push(`Script ${sf} is missing STRS, SVGS, or DATA tables.`);
      continue;
    }

    const strs = JSON.parse(strsMatch[1]);
    const svgs = JSON.parse(svgsMatch[1]);
    const data = JSON.parse(dataMatch[1]);

    for (const s of strs) {
      if (typeof s === 'string' && s.includes('var(--')) {
        errors.push(`Unresolved CSS variable in STRS of ${sf}: ${s}`);
      }
    }
    for (const svg of svgs) {
      if (typeof svg === 'string' && (svg.includes('var(--') || svg.includes('currentColor'))) {
        errors.push(`Unresolved var(--) or currentColor in SVGS of ${sf}`);
      }
    }

    for (const [compName, tuple] of Object.entries(data)) {
      const storiesObj = tuple[1] || {};
      if (!compiledVariants.has(compName)) {
        compiledVariants.set(compName, new Set());
      }
      const set = compiledVariants.get(compName);
      for (const sName of Object.keys(storiesObj)) {
        set.add(sName);
        totalCompiledVariants++;
      }
    }
  }

  for (const [compName, expSet] of expectedVariants.entries()) {
    const gotSet = compiledVariants.get(compName);
    if (!gotSet) {
      errors.push(`Component ${compName} missing from compiled scripts.`);
      continue;
    }
    for (const sName of expSet) {
      if (!gotSet.has(sName)) {
        errors.push(`Variant ${compName}/Story=${sName} missing from compiled scripts.`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    componentsCount: expectedVariants.size,
    expectedVariantsCount: totalExpectedVariants,
    compiledVariantsCount: totalCompiledVariants,
    scriptPartsCount: scriptFiles.length,
    errors,
  };
}

function runSelfTest() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-figma-selftest-'));
  const measuredPath = path.join(tmpDir, 'measured.json');
  const scriptPath = path.join(tmpDir, 'build.js');

  const sampleMeasured = {
    Button: {
      title: 'Actions/Button',
      stories: {
        Default: {
          key: 'Default',
          rootRect: [120, 40],
          items: [
            { kind: 'box', rect: [0, 0, 120, 40], bg: 'rgb(22, 20, 15)', radius: [8, 8, 8, 8] },
            { kind: 'text', rect: [24, 10, 72, 20], text: 'Continue', fontFamily: 'Inter', fontSize: 14, fontWeight: 600, color: 'rgb(250, 246, 238)' },
          ],
        },
      },
    },
  };
  fs.writeFileSync(measuredPath, JSON.stringify(sampleMeasured, null, 2));
  compileMeasuredToFiles(sampleMeasured, scriptPath, '52:2');

  const passReport = verifyMigration(measuredPath, [scriptPath]);
  if (!passReport.ok) {
    throw new Error(`Expected passReport.ok === true, got errors: ${passReport.errors.join('; ')}`);
  }

  // Now inject an unresolved var(--token) and verify it catches the violation
  const badCode = fs.readFileSync(scriptPath, 'utf8').replace('rgb(22, 20, 15)', 'var(--unresolved-token)');
  fs.writeFileSync(scriptPath, badCode);
  const failReport = verifyMigration(measuredPath, [scriptPath]);
  if (failReport.ok) {
    throw new Error('Expected verifyMigration to fail when STRS contains var(--unresolved-token)');
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('PASS: verify-figma-migration.mjs --self-test verified both PASS and FAIL gates.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    runSelfTest();
    process.exit(0);
  }
  const mIdx = args.indexOf('--measured');
  const sIdx = args.indexOf('--scripts');
  if (mIdx < 0 || sIdx < 0) {
    console.error('Usage: node scripts/verify-figma-migration.mjs --measured <measured.json> --scripts <build.js> [...]');
    process.exit(1);
  }
  const measuredPath = args[mIdx + 1];
  const scriptPaths = args.slice(sIdx + 1).filter((a) => !a.startsWith('--'));
  const report = verifyMigration(measuredPath, scriptPaths);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    console.error('STATUS: FAIL');
    process.exit(1);
  }
  console.log('STATUS: PASS');
}
