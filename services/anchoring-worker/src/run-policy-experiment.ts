import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AnchorPolicySimulator, evaluatePolicySet, type PolicyConfig } from './simulator.js';

type CollectedDataset = {
  manifest: {
    datasetName: string;
    version: string;
    chainId: string;
    sourceName: string;
    sourceUrl: string;
    retrievalTimestamp: string;
    requestedRange: { from: string; to: string };
    collectedRange: { from: string; to: string };
    recordCount: number;
    checksum: string;
  };
  blocks: Array<{
    number: string;
    timestamp: string;
    baseFeePerGas: string;
  }>;
};

function parseArguments(argumentsList: string[]) {
  const options: Record<string, string> = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error('Usage: npm run simulate:policies -- --dataset PATH [--output-dir DIR] [--seed NUMBER]');
    }
    options[key] = value;
  }
  if (!options['--dataset']) {
    throw new Error('A validated dataset is required with --dataset');
  }
  return {
    datasetPath: path.resolve(options['--dataset']),
    outputDirectory: path.resolve(options['--output-dir'] ?? '../../research/reports/policy-comparison'),
    seed: Number(options['--seed'] ?? '42'),
  };
}

function parseBigInt(value: string): bigint {
  return value.startsWith('0x') ? BigInt(value) : BigInt(value);
}

function createSyntheticWorkload(count: number, horizonMs: number, seed: number) {
  let state = seed >>> 0;
  const nextRandom = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };

  let arrivedAtMs = 0;
  return Array.from({ length: count }, (_, index) => {
    arrivedAtMs += Math.floor(2_000 + nextRandom() * 6_000);
    const deadlineMs = Math.min(arrivedAtMs + 90_000, horizonMs + 90_000);
    return {
      credentialId: `synthetic-${String(index + 1).padStart(4, '0')}`,
      arrivedAtMs,
      deadlineMs,
    };
  });
}

function formatMarkdown(report: {
  dataset: CollectedDataset['manifest'];
  assumptions: { syntheticCredentialCount: number; seed: number; feeSampleIntervalMs: number; gasUsedPerBatch: string; feeCapWei: string };
  results: Array<{
    name: string;
    totalCostWei: string;
    totalAnchored: number;
    metricSummary: { deadlineViolations: number; averageWaitMs: number; p95WaitMs: number };
  }>;
}) {
  const rows = report.results.map((result) =>
    `| ${result.name} | ${result.totalAnchored} | ${result.metricSummary.deadlineViolations} | ${result.metricSummary.averageWaitMs.toFixed(0)} | ${result.metricSummary.p95WaitMs} | ${result.totalCostWei} |`,
  );
  return [
    '# Deterministic Policy Comparison',
    '',
    '## Evidence and reproducibility',
    '',
    `- Source: ${report.dataset.sourceName} (chain ${report.dataset.chainId})`,
    `- Dataset: ${report.dataset.datasetName}`,
    `- Observations: ${report.dataset.recordCount}; blocks ${report.dataset.collectedRange.from} to ${report.dataset.collectedRange.to}`,
    `- Dataset checksum: ${report.dataset.checksum}`,
    `- Synthetic credential workload: ${report.assumptions.syntheticCredentialCount} arrivals; seed ${report.assumptions.seed}`,
    `- Fee sampling interval: ${report.assumptions.feeSampleIntervalMs} ms`,
    `- Assumed transaction gas: ${report.assumptions.gasUsedPerBatch}`, 
    `- Fee cap: ${report.assumptions.feeCapWei} wei per gas`,
    '',
    '## Results',
    '',
    '| Policy | Anchored | Deadline violations | Mean wait (ms) | P95 wait (ms) | Simulated cost (wei) |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...rows,
    '',
    '## Interpretation limits',
    '',
    'Credential arrivals are synthetic and deterministic, not observed production traffic. The simulator uses historical base-fee observations as a fee profile and assumes a fixed gas amount per batch. It excludes priority fees, gas estimation error, transaction inclusion delay, dropped transactions, congestion externalities, and chain reorganizations. Results compare these stated policies under this workload; they are not production savings claims.',
    '',
  ].join('\n');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const dataset = JSON.parse(await readFile(options.datasetPath, 'utf8')) as CollectedDataset;
  if (!dataset.manifest?.checksum || !Array.isArray(dataset.blocks) || dataset.blocks.length === 0) {
    throw new Error('Input must be a non-empty validated dataset with a provenance manifest');
  }

  const blocks = [...dataset.blocks].sort((left, right) => Number(BigInt(left.number) - BigInt(right.number)));
  const timestamps = blocks.map((block) => Number(parseBigInt(block.timestamp)) * 1_000);
  const averageBlockIntervalMs = timestamps.length > 1
    ? Math.round((timestamps.at(-1)! - timestamps[0]) / (timestamps.length - 1))
    : 12_000;
  const feeProfile = blocks.map((block) => parseBigInt(block.baseFeePerGas));
  const orderedFees = [...feeProfile].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const feeCapWei = orderedFees[Math.floor((orderedFees.length - 1) * 0.75)];
  const horizonMs = Math.max(averageBlockIntervalMs * blocks.length, 1);
  const workload = createSyntheticWorkload(150, horizonMs, options.seed);
  const gasUsedPerBatch = 100_000n;
  const simulator = new AnchorPolicySimulator({
    feeProfile,
    credentialBursts: workload,
    feeSampleIntervalMs: averageBlockIntervalMs,
    gasUsedPerBatch,
  });
  const config: PolicyConfig = {
    batchSizeLimit: 20,
    maxWaitMs: 30_000,
    hardDeadlineMs: 90_000,
    urgentDeadlineMs: 60_000,
    maxFeeWei: feeCapWei,
  };
  const results = evaluatePolicySet(simulator, [
    { name: 'immediate', config },
    { name: 'fixed-interval', config },
    { name: 'fixed-size', config },
    { name: 'gas-threshold', config },
    { name: 'deadline-aware', config },
  ]);

  const report = {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    experimentType: 'historical-fee-profile-with-synthetic-arrivals',
    sourceDatasetPath: path.relative(process.cwd(), options.datasetPath),
    dataset: dataset.manifest,
    assumptions: {
      syntheticCredentialCount: workload.length,
      seed: options.seed,
      feeSampleIntervalMs: averageBlockIntervalMs,
      gasUsedPerBatch: gasUsedPerBatch.toString(),
      feeCapWei: feeCapWei.toString(),
      policyConfig: {
        batchSizeLimit: config.batchSizeLimit,
        maxWaitMs: config.maxWaitMs,
        hardDeadlineMs: config.hardDeadlineMs,
        urgentDeadlineMs: config.urgentDeadlineMs,
      },
    },
    results: results.map((result) => ({
      ...result,
      totalCostWei: result.totalCostWei.toString(),
    })),
  };

  await mkdir(options.outputDirectory, { recursive: true });
  const jsonPath = path.join(options.outputDirectory, 'policy-comparison.json');
  const markdownPath = path.join(options.outputDirectory, 'policy-comparison.md');
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    writeFile(markdownPath, formatMarkdown({
      dataset: dataset.manifest,
      assumptions: report.assumptions,
      results: report.results,
    }), 'utf8'),
  ]);
  console.log(JSON.stringify({ jsonPath, markdownPath, experimentType: report.experimentType, results: report.results }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
