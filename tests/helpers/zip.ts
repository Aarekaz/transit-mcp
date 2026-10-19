/** Minimal ZIP writer for tests: deflate (method 8) or stored (method 0) entries. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function zip(files: Record<string, string>, method: 0 | 8 = 8): Promise<Uint8Array> {
  const local: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = new TextEncoder().encode(text), nameBytes = new TextEncoder().encode(name);
    const body = method === 8 ? new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()) : data;
    const header = new Uint8Array(30 + nameBytes.length), view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(8, method, true);
    view.setUint32(14, crc32(data), true); view.setUint32(18, body.length, true); view.setUint32(22, data.length, true);
    view.setUint16(26, nameBytes.length, true); header.set(nameBytes, 30);
    const entry = new Uint8Array(46 + nameBytes.length), entryView = new DataView(entry.buffer);
    entryView.setUint32(0, 0x02014b50, true); entryView.setUint16(4, 20, true); entryView.setUint16(6, 20, true); entryView.setUint16(10, method, true);
    entryView.setUint32(16, crc32(data), true); entryView.setUint32(20, body.length, true); entryView.setUint32(24, data.length, true);
    entryView.setUint16(28, nameBytes.length, true); entryView.setUint32(42, offset, true); entry.set(nameBytes, 46);
    local.push(header, body); central.push(entry); offset += header.length + body.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22), endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true); endView.setUint16(8, central.length, true); endView.setUint16(10, central.length, true);
  endView.setUint32(12, centralSize, true); endView.setUint32(16, offset, true);
  const parts = [...local, ...central, end], out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0; for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
