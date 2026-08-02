// tests/audio/fakeContext.ts — a headless stand-in for the Web Audio API.
//
// `AudioContext` does not exist in Node and the audio suite has to run with no
// audio device at all (T5.1 brief), so every module under `src/audio` takes its
// context by injection and the tests hand it one of these.
//
// It records what the production code **asks the API to do**: every node it
// creates, every connection it makes, and every parameter event it schedules
// with that event's value and time. That is the whole surface the unit tests
// assert on — a `linearRampToValueAtTime(0.251, t + 1.2)` on the music duck IS
// the ducking matrix, and it is checkable without a speaker.
//
// What this file deliberately cannot answer is whether the browser then makes
// the right *noise*. That is `scripts/capture-audio.ts`'s question, it is
// answered by rendering real DSP through a real `OfflineAudioContext`, and its
// numbers are committed in `docs/calibration/audio.json`.
//
// The one `as unknown as` cast lives in `asAudioContext` at the bottom of the
// file. Implementing the DOM's `AudioContext` in full (300-odd members across
// twenty node types) to satisfy tsc structurally would be a fake nobody could
// read, so the assertion is made once, in one named place, instead of being
// smeared across every test.

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export type ParamOp = 'set' | 'linear' | 'exp' | 'target' | 'cancel';

export interface ParamEvent {
  op: ParamOp;
  value: number;
  time: number;
  /** `setTargetAtTime`'s time constant; 0 for every other op. */
  tc: number;
}

/**
 * `value` is NOT updated by scheduling, on purpose: in a real `AudioParam` it
 * reports the *computed* value, which a fake cannot reproduce without running
 * the automation timeline. Tests assert on {@link events} instead, which is the
 * honest record of what was asked for.
 */
export class FakeAudioParam {
  value: number;
  readonly defaultValue: number;
  readonly events: ParamEvent[] = [];

  constructor(value = 0) {
    this.value = value;
    this.defaultValue = value;
  }

  setValueAtTime(value: number, time: number): FakeAudioParam {
    this.events.push({ op: 'set', value, time, tc: 0 });
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): FakeAudioParam {
    this.events.push({ op: 'linear', value, time, tc: 0 });
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number): FakeAudioParam {
    this.events.push({ op: 'exp', value, time, tc: 0 });
    return this;
  }

  setTargetAtTime(value: number, time: number, tc: number): FakeAudioParam {
    this.events.push({ op: 'target', value, time, tc });
    return this;
  }

  cancelScheduledValues(time: number): FakeAudioParam {
    this.events.push({ op: 'cancel', value: 0, time, tc: 0 });
    return this;
  }

  /** Every event of one kind, in schedule order. */
  ops(op: ParamOp): ParamEvent[] {
    return this.events.filter((e) => e.op === op);
  }

  /** The last event of one kind, or `undefined` if there is none. */
  last(op: ParamOp): ParamEvent | undefined {
    const xs = this.ops(op);
    return xs[xs.length - 1];
  }
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export type NodeKind =
  | 'destination'
  | 'gain'
  | 'oscillator'
  | 'biquad'
  | 'bufferSource'
  | 'panner'
  | 'delay'
  | 'compressor'
  | 'convolver'
  | 'waveShaper'
  | 'constantSource';

export class FakeAudioNode {
  readonly outputs: (FakeAudioNode | FakeAudioParam)[] = [];

  constructor(
    readonly context: FakeAudioContext,
    readonly kind: NodeKind,
  ) {}

  connect<T extends FakeAudioNode | FakeAudioParam>(dest: T): T {
    this.outputs.push(dest);
    return dest;
  }

  disconnect(): void {
    this.outputs.length = 0;
  }
}

/** `AudioScheduledSourceNode`: everything that is started and stopped once. */
export class FakeScheduledNode extends FakeAudioNode {
  startedAt: number | null = null;
  stoppedAt: number | null = null;

  start(when = 0): void {
    this.startedAt = when;
  }

  stop(when = 0): void {
    this.stoppedAt = when;
  }
}

export class FakeGainNode extends FakeAudioNode {
  readonly gain = new FakeAudioParam(1);
}

export class FakeOscillatorNode extends FakeScheduledNode {
  type: OscillatorType = 'sine';
  readonly frequency = new FakeAudioParam(440);
  readonly detune = new FakeAudioParam(0);
  wave: FakePeriodicWave | null = null;

  setPeriodicWave(wave: FakePeriodicWave): void {
    this.wave = wave;
    this.type = 'custom';
  }
}

export class FakeBiquadFilterNode extends FakeAudioNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new FakeAudioParam(350);
  readonly detune = new FakeAudioParam(0);
  readonly Q = new FakeAudioParam(1);
  readonly gain = new FakeAudioParam(0);
}

export class FakeAudioBufferSourceNode extends FakeScheduledNode {
  buffer: FakeAudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  readonly playbackRate = new FakeAudioParam(1);
  readonly detune = new FakeAudioParam(0);
}

export class FakeStereoPannerNode extends FakeAudioNode {
  readonly pan = new FakeAudioParam(0);
}

export class FakeDelayNode extends FakeAudioNode {
  readonly delayTime = new FakeAudioParam(0);
}

export class FakeDynamicsCompressorNode extends FakeAudioNode {
  readonly threshold = new FakeAudioParam(-24);
  readonly knee = new FakeAudioParam(30);
  readonly ratio = new FakeAudioParam(12);
  readonly attack = new FakeAudioParam(0.003);
  readonly release = new FakeAudioParam(0.25);
  readonly reduction = 0;
}

export class FakeConvolverNode extends FakeAudioNode {
  buffer: FakeAudioBuffer | null = null;
  normalize = true;
}

export class FakeWaveShaperNode extends FakeAudioNode {
  curve: Float32Array | null = null;
  oversample: OverSampleType = 'none';
}

export class FakeConstantSourceNode extends FakeScheduledNode {
  readonly offset = new FakeAudioParam(1);
}

// ---------------------------------------------------------------------------
// Buffers and waves
// ---------------------------------------------------------------------------

export class FakeAudioBuffer {
  readonly duration: number;
  private readonly channels: Float32Array[];

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.duration = length / sampleRate;
    this.channels = [];
    for (let i = 0; i < numberOfChannels; i++) {
      this.channels.push(new Float32Array(length));
    }
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel];
  }
}

export class FakePeriodicWave {
  readonly real: Float32Array;
  readonly imag: Float32Array;

  constructor(real: Float32Array | number[], imag: Float32Array | number[]) {
    this.real = Float32Array.from(real);
    this.imag = Float32Array.from(imag);
  }
}

// ---------------------------------------------------------------------------
// The context
// ---------------------------------------------------------------------------

export class FakeAudioContext {
  currentTime = 0;
  state: AudioContextState = 'suspended';
  readonly sampleRate: number;
  readonly destination: FakeAudioNode;
  /** Every node ever created, in creation order. */
  readonly created: FakeAudioNode[] = [];
  readonly buffers: FakeAudioBuffer[] = [];
  readonly periodicWaves: FakePeriodicWave[] = [];
  resumeCalls = 0;
  suspendCalls = 0;
  closeCalls = 0;

  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.destination = new FakeAudioNode(this, 'destination');
  }

  private track<T extends FakeAudioNode>(node: T): T {
    this.created.push(node);
    return node;
  }

  createGain(): FakeGainNode {
    return this.track(new FakeGainNode(this, 'gain'));
  }

  createOscillator(): FakeOscillatorNode {
    return this.track(new FakeOscillatorNode(this, 'oscillator'));
  }

  createBiquadFilter(): FakeBiquadFilterNode {
    return this.track(new FakeBiquadFilterNode(this, 'biquad'));
  }

  createBufferSource(): FakeAudioBufferSourceNode {
    return this.track(new FakeAudioBufferSourceNode(this, 'bufferSource'));
  }

  createStereoPanner(): FakeStereoPannerNode {
    return this.track(new FakeStereoPannerNode(this, 'panner'));
  }

  createDelay(): FakeDelayNode {
    return this.track(new FakeDelayNode(this, 'delay'));
  }

  createDynamicsCompressor(): FakeDynamicsCompressorNode {
    return this.track(new FakeDynamicsCompressorNode(this, 'compressor'));
  }

  createConvolver(): FakeConvolverNode {
    return this.track(new FakeConvolverNode(this, 'convolver'));
  }

  createWaveShaper(): FakeWaveShaperNode {
    return this.track(new FakeWaveShaperNode(this, 'waveShaper'));
  }

  createConstantSource(): FakeConstantSourceNode {
    return this.track(new FakeConstantSourceNode(this, 'constantSource'));
  }

  createBuffer(
    numberOfChannels: number,
    length: number,
    sampleRate: number,
  ): FakeAudioBuffer {
    const buffer = new FakeAudioBuffer(numberOfChannels, length, sampleRate);
    this.buffers.push(buffer);
    return buffer;
  }

  createPeriodicWave(
    real: Float32Array | number[],
    imag: Float32Array | number[],
  ): FakePeriodicWave {
    const wave = new FakePeriodicWave(real, imag);
    this.periodicWaves.push(wave);
    return wave;
  }

  resume(): Promise<void> {
    this.resumeCalls++;
    this.state = 'running';
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    this.suspendCalls++;
    this.state = 'suspended';
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCalls++;
    this.state = 'closed';
    return Promise.resolve();
  }

  // --- test controls -------------------------------------------------------

  /** Move the audio clock forward, the way a running context would. */
  advance(seconds: number): void {
    this.currentTime += seconds;
  }

  /** Every node of one kind, in creation order. */
  nodes(kind: NodeKind): FakeAudioNode[] {
    return this.created.filter((n) => n.kind === kind);
  }

  /** Every node that connects INTO `target`. */
  feeding(target: FakeAudioNode | FakeAudioParam): FakeAudioNode[] {
    return this.created.filter((n) => n.outputs.includes(target));
  }

  /**
   * Is there a signal path from `from` to `to`? Breadth-first over the recorded
   * connections — this is how the bus-graph tests assert audio §2's chain
   * without depending on the exact number of nodes in between.
   */
  reaches(from: FakeAudioNode, to: FakeAudioNode | FakeAudioParam): boolean {
    const seen = new Set<FakeAudioNode | FakeAudioParam>();
    const queue: (FakeAudioNode | FakeAudioParam)[] = [from];
    while (queue.length > 0) {
      const node = queue.shift();
      if (node === undefined || seen.has(node)) {
        continue;
      }
      seen.add(node);
      if (node === to) {
        return true;
      }
      if (node instanceof FakeAudioNode) {
        for (const out of node.outputs) {
          queue.push(out);
        }
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// The casts — every one of them, in one place
// ---------------------------------------------------------------------------

export function asAudioContext(fake: FakeAudioContext): AudioContext {
  return fake as unknown as AudioContext;
}

export function fakeNode(node: AudioNode): FakeAudioNode {
  return node as unknown as FakeAudioNode;
}

export function fakeGain(node: GainNode): FakeGainNode {
  return node as unknown as FakeGainNode;
}

export function fakeFilter(node: BiquadFilterNode): FakeBiquadFilterNode {
  return node as unknown as FakeBiquadFilterNode;
}

export function fakeCompressor(
  node: DynamicsCompressorNode,
): FakeDynamicsCompressorNode {
  return node as unknown as FakeDynamicsCompressorNode;
}

export function fakeParam(param: AudioParam): FakeAudioParam {
  return param as unknown as FakeAudioParam;
}
