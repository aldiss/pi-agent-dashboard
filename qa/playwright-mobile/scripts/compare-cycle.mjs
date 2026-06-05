#!/usr/bin/env node
/**
 * compare-cycle.mjs — compare baseline vs candidate Playwright run JSON,
 * emit decision-canonical markdown verdict + JSON for dashboard-dev/v1 per-commit cycle.
 *
 * Per per-task acceptance contract item #1 (Playwright empirical regression-test PASS/FAIL canonical).
 * Per substrate r8 measurement protocol:
 *   PRIMARY:     click-to-first-paint
 *   SECONDARY-1: ws-replay-frames + first/last frame ms
 *   SECONDARY-2: scroll-stable ms
 *
 * Usage:
 *   node compare-cycle.mjs --baseline <baseline.json> --candidate <candidate.json> \
 *     --commit <sha> --short-sha <short> --output <verdict.md> --output-json <comp.json>
 *
 * Verdict canonical:
 *   PASS  — candidate per-project click-to-first-paint median within ±20% of baseline (defaults canonical)
 *   FAIL  — candidate >120% of baseline on ANY project (regression-canonical surfaced)
 *   NEEDS-MORE-DATA — measurement-tier failures OR insufficient samples for comparison-canonical
 */
import fs from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));

const REGRESSION_THRESHOLD = 1.20; // candidate > 120% of baseline = FAIL

async function main() {
  const baseline = await loadResults(args.baseline);
  const candidate = await loadResults(args.candidate);

  const baselineByProject = extractByProject(baseline, "baseline");
  const candidateByProject = extractByProject(candidate, "candidate");

  // Merge per-project results
  const projects = new Set([...Object.keys(baselineByProject), ...Object.keys(candidateByProject)]);
  const perProject = {};
  let overallVerdict = "PASS";
  let blockingFindings = [];

  for (const project of projects) {
    const b = baselineByProject[project] ?? null;
    const c = candidateByProject[project] ?? null;
    const projectResult = compareProject(project, b, c);
    perProject[project] = projectResult;
    if (projectResult.verdict === "FAIL") {
      overallVerdict = "FAIL";
      blockingFindings.push(...projectResult.findings.filter((f) => f.severity === "blocking"));
    } else if (projectResult.verdict === "NEEDS-MORE-DATA" && overallVerdict === "PASS") {
      overallVerdict = "NEEDS-MORE-DATA";
    }
  }

  const comparison = {
    commit: args.commit,
    shortSha: args["short-sha"],
    verdict: overallVerdict,
    regressionThreshold: REGRESSION_THRESHOLD,
    perProject,
    blockingFindings,
    comparedAt: new Date().toISOString(),
  };

  await fs.writeFile(args["output-json"], JSON.stringify(comparison, null, 2));

  const markdown = renderMarkdownVerdict(comparison);
  await fs.writeFile(args.output, markdown);

  console.log(`Verdict: ${overallVerdict}`);
  console.log(`Verdict markdown: ${args.output}`);
  console.log(`Comparison JSON:  ${args["output-json"]}`);

  process.exit(overallVerdict === "FAIL" ? 1 : 0);
}

async function loadResults(filepath) {
  try {
    const raw = await fs.readFile(filepath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(`WARN: failed to load ${filepath}: ${err.message}`);
    return null;
  }
}

function extractByProject(results, label) {
  // Playwright JSON reporter v1.59+ shape: { suites: [{ specs: [{ tests: [{ projectName, results, attachments }]}]}]}
  // Extract per-project click-to-first-paint from attachments (baseline-fresh-sw.json / baseline-primed-sw.json names)
  const byProject = {};
  if (!results || !Array.isArray(results.suites)) {
    return byProject;
  }
  for (const suite of results.suites) {
    walkSuites(suite, (test) => {
      const project = test.projectName || "unknown-project";
      if (!byProject[project]) {
        byProject[project] = { freshSwMs: null, primedSwMs: null, wsFrames: null, scrollStableMs: null, errors: [] };
      }
      for (const run of test.results || []) {
        // status not in ["passed", "skipped"] = failure canonical
        if (run.status && run.status !== "passed" && run.status !== "skipped") {
          byProject[project].errors.push({ test: test.title, status: run.status });
        }
        for (const att of run.attachments || []) {
          if (att.name && att.name.endsWith(".json") && att.body) {
            try {
              const decoded = JSON.parse(Buffer.from(att.body, "base64").toString("utf-8"));
              if (decoded.primary?.clickToFirstPaintMs != null) {
                if (decoded.label === "fresh-SW") {
                  byProject[project].freshSwMs = decoded.primary.clickToFirstPaintMs;
                } else if (decoded.label === "primed-SW") {
                  byProject[project].primedSwMs = decoded.primary.clickToFirstPaintMs;
                }
                byProject[project].wsFrames = decoded.secondary?.wsReplayFrames ?? byProject[project].wsFrames;
                byProject[project].scrollStableMs = decoded.secondary?.scrollStableMs ?? byProject[project].scrollStableMs;
              }
            } catch (err) {
              // ignore non-JSON attachments
            }
          }
        }
      }
    });
  }
  return byProject;
}

function walkSuites(suite, visit) {
  if (Array.isArray(suite.specs)) {
    for (const spec of suite.specs) {
      for (const test of spec.tests || []) {
        visit(test);
      }
    }
  }
  if (Array.isArray(suite.suites)) {
    for (const child of suite.suites) {
      walkSuites(child, visit);
    }
  }
}

function compareProject(project, b, c) {
  const findings = [];
  let verdict = "PASS";

  if (!b || !c) {
    return {
      verdict: "NEEDS-MORE-DATA",
      baseline: b,
      candidate: c,
      findings: [{ severity: "data-gap", message: `Missing baseline-or-candidate for project ${project}` }],
    };
  }

  if ((b.errors?.length || 0) > 0 || (c.errors?.length || 0) > 0) {
    findings.push({
      severity: "test-failure",
      message: `Test failures detected (baseline=${b.errors?.length || 0}, candidate=${c.errors?.length || 0})`,
    });
    verdict = "NEEDS-MORE-DATA";
  }

  // Compare fresh-SW
  if (b.freshSwMs != null && c.freshSwMs != null) {
    const ratio = c.freshSwMs / b.freshSwMs;
    if (ratio > REGRESSION_THRESHOLD) {
      findings.push({
        severity: "blocking",
        message: `fresh-SW REGRESSION: baseline=${b.freshSwMs.toFixed(0)}ms candidate=${c.freshSwMs.toFixed(0)}ms ratio=${ratio.toFixed(2)}x (>${REGRESSION_THRESHOLD}x threshold)`,
      });
      verdict = "FAIL";
    } else {
      findings.push({
        severity: "info",
        message: `fresh-SW within tolerance: baseline=${b.freshSwMs.toFixed(0)}ms candidate=${c.freshSwMs.toFixed(0)}ms ratio=${ratio.toFixed(2)}x`,
      });
    }
  } else {
    findings.push({ severity: "data-gap", message: `fresh-SW data missing (baseline=${b.freshSwMs}, candidate=${c.freshSwMs})` });
    if (verdict === "PASS") verdict = "NEEDS-MORE-DATA";
  }

  // Compare primed-SW
  if (b.primedSwMs != null && c.primedSwMs != null) {
    const ratio = c.primedSwMs / b.primedSwMs;
    if (ratio > REGRESSION_THRESHOLD) {
      findings.push({
        severity: "blocking",
        message: `primed-SW REGRESSION: baseline=${b.primedSwMs.toFixed(0)}ms candidate=${c.primedSwMs.toFixed(0)}ms ratio=${ratio.toFixed(2)}x (>${REGRESSION_THRESHOLD}x threshold)`,
      });
      verdict = "FAIL";
    } else {
      findings.push({
        severity: "info",
        message: `primed-SW within tolerance: baseline=${b.primedSwMs.toFixed(0)}ms candidate=${c.primedSwMs.toFixed(0)}ms ratio=${ratio.toFixed(2)}x`,
      });
    }
  } else {
    findings.push({ severity: "data-gap", message: `primed-SW data missing (baseline=${b.primedSwMs}, candidate=${c.primedSwMs})` });
    if (verdict === "PASS") verdict = "NEEDS-MORE-DATA";
  }

  return { verdict, baseline: b, candidate: c, findings };
}

function renderMarkdownVerdict(comparison) {
  const lines = [];
  lines.push(`# Cycle verdict — commit \`${comparison.shortSha}\` — **${comparison.verdict}**`);
  lines.push("");
  lines.push(`**Compared at:** ${comparison.comparedAt}`);
  lines.push(`**Regression threshold:** candidate / baseline > ${comparison.regressionThreshold}x = FAIL`);
  lines.push("");

  lines.push("## Per-project click-to-first-paint comparison");
  lines.push("");
  lines.push("| Project | fresh-SW baseline (ms) | fresh-SW candidate (ms) | fresh-SW ratio | primed-SW baseline (ms) | primed-SW candidate (ms) | primed-SW ratio | Verdict |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const [project, result] of Object.entries(comparison.perProject)) {
    const b = result.baseline || {};
    const c = result.candidate || {};
    const freshRatio = b.freshSwMs && c.freshSwMs ? (c.freshSwMs / b.freshSwMs).toFixed(2) + "x" : "—";
    const primedRatio = b.primedSwMs && c.primedSwMs ? (c.primedSwMs / b.primedSwMs).toFixed(2) + "x" : "—";
    lines.push(`| \`${project}\` | ${fmt(b.freshSwMs)} | ${fmt(c.freshSwMs)} | ${freshRatio} | ${fmt(b.primedSwMs)} | ${fmt(c.primedSwMs)} | ${primedRatio} | **${result.verdict}** |`);
  }
  lines.push("");

  if (comparison.blockingFindings.length > 0) {
    lines.push("## Blocking findings");
    lines.push("");
    for (const f of comparison.blockingFindings) {
      lines.push(`- ${f.message}`);
    }
    lines.push("");
  }

  lines.push("## Per-project findings (all severities)");
  lines.push("");
  for (const [project, result] of Object.entries(comparison.perProject)) {
    lines.push(`### \`${project}\` — ${result.verdict}`);
    lines.push("");
    for (const f of result.findings) {
      lines.push(`- **${f.severity}**: ${f.message}`);
    }
    lines.push("");
  }

  lines.push("## Decision canonical (per per-task acceptance contract)");
  lines.push("");
  if (comparison.verdict === "PASS") {
    lines.push("- ✅ Empirical regression-test PASS canonical (item #1)");
    lines.push("- ▶️ Sister-peers (Wizard junction-review + Gatekeeper panel-diversity + Velocity-advisor momentum) verdicts canonical-trigger-canonical at cycle-DONE moment");
    lines.push("- ▶️ Operator-pacing ratify per NOS §5 canonical");
    lines.push("- ▶️ Commit-canonical fire IFF all canonical-ratifies converge");
  } else if (comparison.verdict === "FAIL") {
    lines.push("- ❌ Empirical regression-test FAIL canonical (item #1)");
    lines.push("- ▶️ Root-cause diagnosis canonical-required at cell-executor + Wizard junction-review");
    lines.push("- ▶️ Fix-vs-defer decision canonical at operator-pacing-ratify");
    lines.push("- ⏸️ Commit-canonical fire BLOCKED");
  } else {
    lines.push("- ⚠️ NEEDS-MORE-DATA — measurement-tier-gap canonical");
    lines.push("- ▶️ Investigate test-failure / data-gap findings canonical");
    lines.push("- ⏸️ Cycle-canonical-continue blocked on data-quality canonical");
  }

  return lines.join("\n") + "\n";
}

function fmt(v) {
  return v == null ? "—" : v.toFixed(0);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1];
      i++;
    }
  }
  return args;
}

main().catch((err) => {
  console.error("compare-cycle.mjs FAILED:", err);
  process.exit(2);
});
