/** Minimal read-only ZIP access for published GTFS archives, using the platform's
 * streaming inflater. Unsupported features (ZIP64, encryption, other methods) fail
 * closed rather than being guessed. */
export interface ZipEntry { name: string; method: 0 | 8; compressedSize: number; size: number; localOffset: number }

const END_OF_CENTRAL_DIRECTORY = 0x06054b50, CENTRAL_HEADER = 0x02014b50, LOCAL_HEADER = 0x04034b50;

export function readZipDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  const earliest = Math.max(0, bytes.length - 22 - 0xffff);
  while (end >= earliest && view.getUint32(end, true) !== END_OF_CENTRAL_DIRECTORY) end--;
  if (end < earliest) throw new Error('Invalid ZIP archive');
  const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true);
  let cursor = view.getUint32(end + 16, true);
  if (count === 0xffff || cursor === 0xffffffff || size === 0xffffffff || cursor + size > end) throw new Error('Unsupported ZIP archive');
  const entries = new Map<string, ZipEntry>();
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== CENTRAL_HEADER) throw new Error('Invalid ZIP directory');
    const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true), uncompressed = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true), extraLength = view.getUint16(cursor + 30, true), commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (flags & 0x1 || (method !== 0 && method !== 8) || [compressedSize, uncompressed, localOffset].includes(0xffffffff)) throw new Error(`Unsupported ZIP entry: ${name}`);
    // GTFS tables live at the archive root; nested or duplicate names are not guessed at.
    const base = name.slice(name.lastIndexOf('/') + 1);
    if (!name.endsWith('/') && base) {
      if (entries.has(base)) throw new Error(`Ambiguous ZIP entry: ${base}`);
      entries.set(base, { name, method: method as 0 | 8, compressedSize, size: uncompressed, localOffset });
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Streams one entry's bytes. The declared size is enforced. */
export function zipEntryStream(bytes: Uint8Array, entry: ZipEntry): ReadableStream<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(entry.localOffset, true) !== LOCAL_HEADER) throw new Error(`Invalid ZIP entry: ${entry.name}`);
  const start = entry.localOffset + 30 + view.getUint16(entry.localOffset + 26, true) + view.getUint16(entry.localOffset + 28, true);
  if (start + entry.compressedSize > bytes.length) throw new Error(`Truncated ZIP entry: ${entry.name}`);
  const data = new Blob([bytes.subarray(start, start + entry.compressedSize)]).stream();
  const inflated = entry.method === 8 ? data.pipeThrough(new DecompressionStream('deflate-raw')) : data;
  let total = 0;
  return inflated.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > entry.size) throw new Error(`ZIP entry larger than declared: ${entry.name}`);
      controller.enqueue(chunk);
    },
    flush() { if (total !== entry.size) throw new Error(`ZIP entry size mismatch: ${entry.name}`); },
  }));
}

export async function zipEntryText(bytes: Uint8Array, entry: ZipEntry): Promise<string> {
  return new Response(zipEntryStream(bytes, entry)).text();
}
