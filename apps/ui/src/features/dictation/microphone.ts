import { SAMPLE_RATE } from "./model.ts";

// Listens to the microphone for dictation: mono samples at Whisper's 16 kHz, gathered as they come,
// and how loud the user is right now for the recording's meter.

/** Copies each block of samples the microphone delivers to the page; tiny, so it is inlined. */
const captureProcessor = `
registerProcessor("cerium-capture", class extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
});
`;

export interface Microphone {
  /** Every sample heard since the last `take`, which empties the store. */
  readonly take: () => Float32Array;
  /** How many samples are waiting for `take`. */
  readonly waiting: () => number;
  /** How loud the user is right now, 0 to 1. */
  readonly level: () => number;
  /** Lets go of the microphone; the samples not yet taken are returned. */
  readonly stop: () => Float32Array;
}

const join = (blocks: ReadonlyArray<Float32Array>, length: number) => {
  const joined = new Float32Array(length);
  let at = 0;
  for (const block of blocks) {
    joined.set(block, at);
    at += block.length;
  }
  return joined;
};

/** Starts listening; rejects with getUserMedia's own error when the microphone can't be had. */
export const openMicrophone = async (): Promise<Microphone> => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  const release = () => {
    for (const track of stream.getTracks()) track.stop();
    void context.close();
  };
  try {
    const module = URL.createObjectURL(new Blob([captureProcessor], { type: "text/javascript" }));
    await context.audioWorklet.addModule(module).finally(() => URL.revokeObjectURL(module));
    const source = context.createMediaStreamSource(stream);
    // No outputs: Chromium runs a node without any whether or not it reaches the speakers.
    const capture = new AudioWorkletNode(context, "cerium-capture", { numberOfOutputs: 0 });
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    source.connect(capture);
    let blocks: Array<Float32Array> = [];
    let length = 0;
    capture.port.addEventListener("message", (event: MessageEvent<Float32Array>) => {
      blocks.push(event.data);
      length += event.data.length;
    });
    capture.port.start();
    const levels = new Float32Array(analyser.fftSize);

    const take = () => {
      const taken = join(blocks, length);
      blocks = [];
      length = 0;
      return taken;
    };
    return {
      take,
      waiting: () => length,
      level: () => {
        analyser.getFloatTimeDomainData(levels);
        let sum = 0;
        for (const sample of levels) sum += sample * sample;
        // Speech sits around -30 dBFS; scale so it fills most of the meter.
        return Math.min(1, Math.sqrt(sum / levels.length) * 6);
      },
      stop: () => {
        capture.port.close();
        release();
        return take();
      },
    };
  } catch (error) {
    release();
    throw error;
  }
};
