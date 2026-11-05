import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameMetrics } from '../src/frame-metrics.js';

test('frame diagnostics retain dropped frames, ignore pauses and distinguish submission time', () => {
  const m = new FrameMetrics();
  m.record(0, 3);
  m.record(10, 4);
  m.record(20, 5);
  m.record(50, 6);
  m.record(1000, 8);
  assert.deepEqual(m.snapshot(100), {
    samples: 3, frameIntervalP95Ms: 30, cpuSubmissionP95Ms: 6, targetRate: 100, lateFrames: 1,
  });
  for (let i = 1; i <= 300; i++) m.record(1000 + i * 10, 2);
  assert.equal(m.snapshot(100).samples, 240);
  assert.equal(m.snapshot(100).lateFrames, 0);
});
