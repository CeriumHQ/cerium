import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";

export async function download(
  url: string,
  destination: string,
  progress?: (percent: number) => void,
  signal?: AbortSignal,
) {
  const timeout = AbortSignal.timeout(10 * 60_000);
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
  const source = Readable.fromWeb(response.body);
  const size = Number(response.headers.get("content-length"));
  if (progress && size > 0) {
    let received = 0,
      last = 0;
    source.on("data", (chunk: Buffer) => {
      received += chunk.byteLength;
      const percent = Math.min(100, Math.floor((received / size) * 100));
      if (percent > last) progress(percent);
      last = percent;
    });
  }
  await pipeline(source, createWriteStream(destination, { flags: "wx" }));
}

export async function sha256(file: string) {
  const hash = createHash("sha256");
  for await (const part of createReadStream(file)) hash.update(part);
  return hash.digest("hex");
}

export function checksum(contents: string, asset: string) {
  for (const line of contents.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line);
    if (match && match[2] === asset) return match[1]!.toLowerCase();
  }
  throw new Error(`Missing SHA-256 checksum for ${asset}.`);
}

export const systemTar =
  process.platform === "win32"
    ? join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";

export function extract(file: string, directory: string) {
  if (file.endsWith(".zip") && process.platform !== "win32")
    execFileSync("unzip", ["-q", file, "-d", directory], { stdio: "inherit" });
  else execFileSync(systemTar, ["-xf", file, "-C", directory], { stdio: "inherit" });
}
