// Turns speech into text off the main thread: Whisper, run by Transformers.js on the GPU through
// WebGPU, or on the CPU through WebAssembly where there is no GPU to use. Audio never leaves the
// computer; the model's weights download from Hugging Face on first use and stay in the page's cache.

import {
  env,
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
  type ProgressInfo,
} from "@huggingface/transformers";
// The ONNX runtime's WebAssembly ships with the app rather than loading from a CDN.
import runtimeScript from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import runtimeBinary from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";

import { speechModel, type SpeechModelId } from "./model.ts";
import type { SpeechRequest, SpeechResponse } from "./speech.ts";

env.allowLocalModels = false;
const onnx = env.backends.onnx;
if (onnx.wasm) {
  onnx.wasm.wasmPaths = {
    mjs: new URL(runtimeScript, self.location.href).href,
    wasm: new URL(runtimeBinary, self.location.href).href,
  };
}

const post = (response: SpeechResponse) => self.postMessage(response);

/** WebGPU when the machine has an adapter for it; it runs Whisper several times faster. */
const pickDevice = async (): Promise<{ device: "webgpu" | "wasm"; halfFloats: boolean }> => {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<GpuAdapter | null> } }).gpu;
  const adapter = await gpu?.requestAdapter().catch(() => null);
  return adapter
    ? { device: "webgpu", halfFloats: adapter.features.has("shader-f16") }
    : { device: "wasm", halfFloats: false };
};
interface GpuAdapter {
  readonly features: ReadonlySet<string>;
}

let loaded:
  | { readonly id: SpeechModelId; readonly pipe: Promise<AutomaticSpeechRecognitionPipeline> }
  | undefined;

const load = (id: SpeechModelId) => {
  if (loaded?.id === id) return loaded.pipe;
  const previous = loaded?.pipe;
  const model = speechModel(id);
  let shown = 0;
  const pipe = (async () => {
    await previous?.then((each) => each.dispose()).catch(() => undefined);
    const { device, halfFloats } = await pickDevice();
    const created = await pipeline("automatic-speech-recognition", model.repo, {
      device,
      // The encoder at full or half precision on a GPU, which runs it fastest; the decoder at
      // four bits there. Eight bits for both on a CPU.
      dtype:
        device === "webgpu"
          ? { encoder_model: halfFloats ? "fp16" : "fp32", decoder_model_merged: "q4" }
          : { encoder_model: "q8", decoder_model_merged: "q8" },
      progress_callback: (info: ProgressInfo) => {
        if (info.status !== "progress_total") return;
        // Each file adds to the total as it starts, so the share only ever moves forward.
        const share = Math.max(shown, Math.min(1, info.loaded / Math.max(info.total, model.size * 1e6)));
        if (share - shown < 0.01 && share < 1) return;
        shown = share;
        post({ kind: "progress", model: id, share });
      },
    });
    post({ kind: "ready", model: id, device });
    return created as AutomaticSpeechRecognitionPipeline;
  })();
  loaded = { id, pipe };
  // A failed download is tried again on the next request.
  pipe.catch(() => {
    if (loaded?.pipe === pipe) loaded = undefined;
  });
  return pipe;
};

/** A fetch that never reached Hugging Face, as against a model that failed to run. */
const isDownloadError = (error: unknown) =>
  error instanceof TypeError ||
  (error instanceof Error && /fetch|network|download|load/i.test(error.message));

self.addEventListener("message", (event: MessageEvent<SpeechRequest>) => {
  const request = event.data;
  if (request.kind === "prepare") {
    load(request.model).catch((error: unknown) =>
      post({
        kind: "failed",
        problem: isDownloadError(error) ? "download" : "failed",
        message: String(error),
      }),
    );
    return;
  }
  load(request.model)
    .then(async (transcribe) => {
      const output = await transcribe(request.audio, {
        language: request.language,
        task: "transcribe",
        chunk_length_s: 30,
        stride_length_s: 5,
      });
      const text = (Array.isArray(output) ? output : [output]).map((each) => each.text).join(" ");
      post({ kind: "done", id: request.id, text });
    })
    .catch((error: unknown) =>
      post({
        kind: "failed",
        id: request.id,
        problem: isDownloadError(error) ? "download" : "failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
});
