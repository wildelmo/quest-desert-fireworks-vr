// Fixed storage on the frame path; sorting/allocations only when inspected.
export class FrameMetrics {
  constructor() {
    this.intervals = new Float32Array(240);
    this.submission = new Float32Array(240);
    this.count = 0;
    this.head = 0;
    this.last = null;
  }

  record(timestamp, submissionMs) {
    const interval = this.last === null ? 0 : timestamp - this.last;
    this.last = timestamp;
    // Ignore tab/session transitions and pauses; retain normal dropped frames.
    if (!(interval > 0 && interval < 250)) return;
    this.intervals[this.head] = interval;
    this.submission[this.head] = submissionMs;
    this.head = (this.head + 1) % this.intervals.length;
    this.count = Math.min(this.count + 1, this.intervals.length);
  }

  snapshot(targetRate) {
    const intervals = Array.from(this.intervals.subarray(0, this.count)).sort((a, b) => a - b);
    const submission = Array.from(this.submission.subarray(0, this.count)).sort((a, b) => a - b);
    const p95 = Math.max(0, Math.ceil(this.count * 0.95) - 1);
    return {
      samples: this.count,
      frameIntervalP95Ms: intervals[p95] ?? null,
      cpuSubmissionP95Ms: submission[p95] ?? null,
      targetRate: targetRate ?? null,
      lateFrames: targetRate ? intervals.filter((ms) => ms > 1500 / targetRate).length : null,
    };
  }
}
