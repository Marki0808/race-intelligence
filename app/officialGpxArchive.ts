import { createHash } from "node:crypto";
import yauzl from "yauzl";
import { parseGpxText } from "./gpxAnalysis.ts";

export const OFFICIAL_GPX_ARCHIVE_LIMITS = {
  maxCompressedBytes: 4 * 1024 * 1024,
  maxEntries: 32,
  maxExpandedBytes: 16 * 1024 * 1024,
  maxGpxBytes: 4 * 1024 * 1024,
} as const;

export type ExtractedGpxFile = { id: string; displayLabel: string; text: string };
export type GpxArchiveInspectionResult =
  | { status: "success"; archiveDigest: string; files: ExtractedGpxFile[] }
  | { status: "invalid-archive" | "unsafe-archive" | "archive-too-large" | "no-gpx-in-archive" };

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

function updateCrc32(bytes: Uint8Array, previous = 0): number {
  let value = (previous ^ 0xffffffff) >>> 0;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function isSafeArchivePath(name: string): boolean {
  if (!name || name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[a-z]:/i.test(name)) return false;
  const path = name.endsWith("/") ? name.slice(0, -1) : name;
  return path.length > 0 && path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isSafeEntryType(entry: yauzl.Entry): boolean {
  if ((entry.externalFileAttributes & 0x400) !== 0) return false; // Windows reparse point.
  const hostOs = entry.versionMadeBy >>> 8;
  if (hostOs !== 3 && hostOs !== 19) return true;
  const mode = entry.externalFileAttributes >>> 16;
  const type = mode & 0xf000;
  return type === 0 || type === 0x8000 || type === 0x4000;
}

function isDirectory(entry: yauzl.Entry): boolean {
  return entry.fileName.endsWith("/") || (((entry.externalFileAttributes >>> 16) & 0xf000) === 0x4000);
}

function archiveFailure(error: unknown): GpxArchiveInspectionResult {
  const message = error instanceof Error ? error.message : "";
  return /absolute path|invalid relative path|invalid characters in fileName/i.test(message)
    ? { status: "unsafe-archive" }
    : { status: "invalid-archive" };
}

export async function inspectGpxArchive(archiveBytes: Uint8Array): Promise<GpxArchiveInspectionResult> {
  if (archiveBytes.byteLength > OFFICIAL_GPX_ARCHIVE_LIMITS.maxCompressedBytes) return { status: "archive-too-large" };
  const archiveDigest = createHash("sha256").update(archiveBytes).digest("hex");

  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.fromBufferPromise(Buffer.from(archiveBytes), {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    });
  } catch (error) {
    return archiveFailure(error);
  }

  if (zip.entryCount > OFFICIAL_GPX_ARCHIVE_LIMITS.maxEntries) return { status: "archive-too-large" };
  const output: ExtractedGpxFile[] = [];
  const seenContents = new Set<string>();
  let expandedBytes = 0;
  let fileIndex = 0;

  try {
    const entries: yauzl.Entry[] = [];
    for await (const entry of zip.eachEntry()) {
      if (!isSafeArchivePath(entry.fileName) || !isSafeEntryType(entry)) return { status: "unsafe-archive" };
      if (entry.isEncrypted() || !entry.canDecodeFileData()) return { status: "invalid-archive" };
      if (!Number.isSafeInteger(entry.compressedSize) || !Number.isSafeInteger(entry.uncompressedSize) || entry.compressedSize < 0 || entry.uncompressedSize < 0) {
        return { status: "invalid-archive" };
      }
      if (entry.uncompressedSize > OFFICIAL_GPX_ARCHIVE_LIMITS.maxExpandedBytes - expandedBytes) return { status: "archive-too-large" };
      expandedBytes += entry.uncompressedSize;
      if (/\.gpx$/i.test(entry.fileName) && entry.uncompressedSize > OFFICIAL_GPX_ARCHIVE_LIMITS.maxGpxBytes) return { status: "archive-too-large" };
      if (isDirectory(entry)) {
        if (entry.uncompressedSize !== 0) return { status: "invalid-archive" };
        continue;
      }
      entries.push(entry);
    }

    let observedExpandedBytes = 0;
    for (const entry of entries) {
      const retainForValidation = entry.uncompressedSize <= OFFICIAL_GPX_ARCHIVE_LIMITS.maxGpxBytes;
      const chunks: Buffer[] = [];
      let prefix = Buffer.alloc(0);
      let entryBytes = 0;
      let entryCrc = 0;
      const stream = await zip.openReadStreamPromise(entry);
      for await (const rawChunk of stream) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        entryBytes += chunk.byteLength;
        observedExpandedBytes += chunk.byteLength;
        if (entryBytes > entry.uncompressedSize || observedExpandedBytes > expandedBytes || observedExpandedBytes > OFFICIAL_GPX_ARCHIVE_LIMITS.maxExpandedBytes) {
          stream.destroy();
          return { status: "archive-too-large" };
        }
        entryCrc = updateCrc32(chunk, entryCrc);
        if (retainForValidation) chunks.push(chunk);
        else if (prefix.byteLength < 4_096) prefix = Buffer.concat([prefix, chunk.subarray(0, 4_096 - prefix.byteLength)]);
      }
      if (entryBytes !== entry.uncompressedSize || entryCrc !== entry.crc32) return { status: "invalid-archive" };
      if (!retainForValidation) {
        const header = new TextDecoder("utf-8", { fatal: false }).decode(prefix).replace(/^\uFEFF/, "");
        if (/^\s*(?:<\?xml\b[^>]*\?>\s*)?<(?:[\w.-]+:)?gpx(?:\s|>)/i.test(header)) return { status: "archive-too-large" };
        continue;
      }

      const contents = Buffer.concat(chunks, entryBytes);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
        parseGpxText(text);
      } catch {
        continue;
      }
      const digest = createHash("sha256").update(contents).digest("hex");
      if (seenContents.has(digest)) continue;
      seenContents.add(digest);
      fileIndex++;
      output.push({ id: `gpx-${fileIndex}`, displayLabel: `GPX file ${fileIndex}`, text });
    }
  } catch (error) {
    return archiveFailure(error);
  }

  return output.length ? { status: "success", archiveDigest, files: output } : { status: "no-gpx-in-archive" };
}
