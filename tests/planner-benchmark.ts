import { planJourney } from '../src/transit/planner/plan';
import { at, plannerFixture, plannerInput, transferInput } from './helpers/planner-fixture';

// Small deterministic corpus benchmark; fixture construction is excluded but
// decoding, routing and independent validation are included in every sample.
const input = plannerInput();
input.files['frequencies.txt'] = 'trip_id,start_time,end_time,headway_secs,exact_times\nT,09:00:00,10:00:00,300,1\n';
const transfer = transferInput();
transfer.files['trips.txt'] = transfer.files['trips.txt'].replaceAll(',block', ',');
const corpus = await Promise.all([plannerFixture(), plannerFixture(transfer), plannerFixture(input), plannerFixture(transferInput())]);
const samples: number[] = [];
const baseline = process.memoryUsage();
let peakHeap = baseline.heapUsed, peakExternal = baseline.external, peakEstimate = 0;
for (let iteration = 0; iteration < 100; iteration++) {
  const fixture = corpus[iteration % corpus.length]!;
  const query = iteration % 5 === 0 ? { ...fixture.query, origin: { latitude: 37.001, longitude: -122 }, departAt: at('08:55:00'), maxWalkMetres: 200 } : fixture.query;
  const before = performance.now(), result = await planJourney(query);
  samples.push(performance.now() - before);
  if (!result.candidates.length) throw new Error('Benchmark fixture unexpectedly has no itinerary');
  const memory = process.memoryUsage(); peakHeap = Math.max(peakHeap, memory.heapUsed); peakExternal = Math.max(peakExternal, memory.external);
  peakEstimate = Math.max(peakEstimate, result.diagnostics.estimatedWorkingSetBytes);
}
samples.sort((a, b) => a - b);
const report = { samples: samples.length, p50Ms: samples[49], p95Ms: samples[94], maxMs: samples.at(-1),
  peakEstimatedWorkingSetBytes: peakEstimate, peakHeapUsedBytes: peakHeap, peakExternalBytes: peakExternal,
  peakHeapIncreaseBytes: peakHeap - baseline.heapUsed, peakExternalIncreaseBytes: peakExternal - baseline.external };
console.log(JSON.stringify(report, null, 2));
if (report.p95Ms! >= 250 || peakEstimate >= 64 * 1024 * 1024 || report.peakHeapIncreaseBytes + report.peakExternalIncreaseBytes >= 64 * 1024 * 1024) {
  throw new Error('Planner fixture gate failed: move interface behind dedicated Durable Object');
}
