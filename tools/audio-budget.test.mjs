// Exercise the shipping engine against an independently counted audio graph.
// In particular, source.stop(t) does NOT end a source until t is reached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { AudioEngine, AUDIO_LIMITS } from '../src/audio.js';

class FakeContext {
  currentTime = 0;
  sampleRate = 48000;
  nodes = [];
  sources = [];
  peak = 0;
  node() {
    const param = () => ({ value: 0, setTargetAtTime() {}, setValueAtTime() {},
      cancelAndHoldAtTime() {}, cancelScheduledValues() {}, linearRampToValueAtTime() {} });
    const node = { connected: false, disconnected: false,
      connect() { this.connected = true; },
      disconnect() { this.disconnected = true; },
      gain: param(), playbackRate: param(), positionX: param(), positionY: param(),
      positionZ: param(), delayTime: param(), frequency: param() };
    this.nodes.push(node);
    return node;
  }
  createGain() { return this.node(); }
  createPanner() { return this.node(); }
  createDelay() { return this.node(); }
  createBiquadFilter() { return this.node(); }
  createBufferSource() {
    const src = this.node();
    src.start = (t) => {
      src.when = t;
      src.end = src.loop ? Infinity : t + src.buffer.duration / src.playbackRate.value;
      this.peak = Math.max(this.peak, this.allocated());
      assert.ok(this.allocated() <= AUDIO_LIMITS.voices, 'actual source allocations exceeded ceiling');
    };
    src.stop = (t) => { src.end = Math.min(src.end, t); };
    this.sources.push(src);
    return src;
  }
  allocated() { return this.sources.filter((s) => !s.disconnected).length; }
  advance(t) {
    this.currentTime = t;
    for (const s of this.sources) {
      if (!s.disconnected && s.end <= t) s.onended?.();
    }
  }
}

function setup() {
  const engine = new AudioEngine();
  engine.ctx = new FakeContext();
  engine.ready = true;
  engine.master = {}; engine.convolver = {};
  engine.lib = Object.fromEntries(['test', 'boomBig', 'boomMed', 'boomSmall', 'crackle']
    .map((name) => [name, [{ duration: 5 }]]));
  const pos = new Vector3(0, 1.6, -1);
  return { engine, ctx: engine.ctx, pos };
}

test('mixed positional/flat/loop/scheduled floods never allocate beyond the global ceiling', () => {
  const { engine, ctx, pos } = setup();
  for (let wave = 0; wave < 100; wave++) {
    for (let i = 0; i < 100; i++) {
      const opts = { gain: 0.1 + i, loop: i % 7 === 0, hrtf: true,
        startDelay: i % 3, lowpass: 3000 };
      if (i % 2) engine.play('test', pos, opts);
      else engine.playFlat('test', opts);
      const d = engine.getDiagnostics();
      assert.equal(d.voices, ctx.allocated());
      assert.ok(d.loops <= AUDIO_LIMITS.loops);
      assert.ok(d.hrtf <= AUDIO_LIMITS.hrtf);
    }
    ctx.advance(ctx.currentTime + 0.5);
  }
  assert.ok(engine.getDiagnostics().refused > 0);
  for (const v of engine._voices) v.stop(0.02);
  ctx.advance(100);
  assert.equal(ctx.allocated(), 0);
  assert.equal(engine.getDiagnostics().voices, 0);
  assert.ok(ctx.nodes.every((n) => n.disconnected), 'all per-voice nodes must be disconnected');
});

test('higher priority arrivals cannot hide fade-out costs or repeatedly extend fades', () => {
  const { engine, ctx, pos } = setup();
  for (let i = 0; i < AUDIO_LIMITS.steadyVoices; i++) engine.play('test', pos, { gain: 0.1 });
  ctx.advance(1);
  for (let i = 0; i < 300; i++) engine.play('test', pos, { gain: 2 + i });
  assert.equal(ctx.allocated(), AUDIO_LIMITS.voices);
  assert.equal(engine.getDiagnostics().voices, ctx.allocated());
  assert.ok(engine.getDiagnostics().fading > 0);
  const stopTimes = ctx.sources.map((s) => s.end);
  for (const v of engine._voices) if (v.stopping) v.stop(2);
  assert.deepEqual(ctx.sources.map((s) => s.end), stopTimes);
  ctx.advance(1.03);
  assert.ok(ctx.allocated() < AUDIO_LIMITS.voices);
  assert.ok(engine.play('test', pos, { gain: 4 }));
});

test('delayed sources hold slots, are cancelled safely, and only release on ended', () => {
  const { engine, ctx, pos } = setup();
  const h = engine.play('test', pos, { startDelay: 20 });
  assert.equal(engine.getDiagnostics().scheduled, 1);
  h.stop(); h.stop(2); h.setGain(10); h.setRate(2);
  assert.equal(ctx.allocated(), 1);
  ctx.advance(0);
  assert.equal(ctx.allocated(), 0);
  assert.equal(h.ended, true);
});

test('loops have a separate cap and HRTF falls back to equalpower', () => {
  const { engine, ctx, pos } = setup();
  const handles = [];
  for (let i = 0; i < 100; i++) {
    const h = engine.play('test', pos, { loop: true, hrtf: true });
    if (h) handles.push(h);
  }
  assert.equal(handles.length, AUDIO_LIMITS.loops);
  assert.equal(handles.filter((h) => h.panner.panningModel === 'HRTF').length, AUDIO_LIMITS.hrtf);
  for (const h of handles) h.stop();
  assert.equal(ctx.allocated(), AUDIO_LIMITS.loops);
  ctx.advance(0.1);
  assert.equal(ctx.allocated(), 0);
});

test('a refused explosion never allocates its trailing crackle', () => {
  const { engine, ctx, pos } = setup();
  for (let i = 0; i < 100; i++) engine.playFlat('test');
  const before = ctx.sources.length;
  for (let i = 0; i < 100; i++) engine.boom(pos, 1, { crackle: true });
  assert.equal(ctx.sources.length, before);
});

test('invalid initial parameters and unknown samples allocate no nodes', () => {
  const { engine, ctx, pos } = setup();
  for (const opts of [{ gain: NaN }, { gain: -1 }, { rate: 0 }, { rate: Infinity },
    { startDelay: -1 }, { refDistance: 0 }, { lowpass: NaN }, { send: Infinity }]) {
    assert.equal(engine.play('test', pos, opts), null);
    assert.equal(engine.playFlat('test', opts), null);
  }
  assert.equal(engine.play('test', new Vector3(NaN, 1, 2)), null);
  assert.equal(engine.play('missing', pos), null);
  assert.equal(ctx.nodes.length, 0);
});

test('failed graph construction releases its reservation and every allocated node', () => {
  const { engine, ctx, pos } = setup();
  ctx.createPanner = () => { throw new Error('intentional allocation failure'); };
  const warn = console.warn;
  console.warn = () => {};
  try { assert.equal(engine.play('test', pos), null); }
  finally { console.warn = warn; }
  assert.equal(ctx.allocated(), 0);
  assert.equal(engine.getDiagnostics().voices, 0);
  assert.ok(ctx.nodes.every((n) => n.disconnected));
});
