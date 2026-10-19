export type GtfsCsvRow = Record<string, string>;

/** Minimal RFC 4180 parser with strict row width and header validation. */
export function parseGtfsCsv(source: string): GtfsCsvRow[] {
  const rows = parseRows(source.charCodeAt(0) === 0xFEFF ? source.slice(1) : source);
  if (rows.length === 0) return [];

  const headers = rows[0]!;
  if (new Set(headers).size !== headers.length) {
    throw new Error('Duplicate GTFS header');
  }

  return rows.slice(1)
    .filter(row => !(row.length === 1 && row[0] === ''))
    .map((row, index) => {
      if (row.length !== headers.length) {
        throw new Error(`GTFS row ${index + 2} has ${row.length} columns; expected ${headers.length}`);
      }
      return Object.fromEntries(headers.map((header, column) => [header, row[column]!]));
    });
}

/** Fields of one raw record, as produced by csvRecords. */
export function parseCsvRecord(record: string): string[] {
  // Unquoted records (almost all GTFS rows) split identically without the state machine.
  if (!record.includes('"')) return record.split(',');
  return parseRows(record)[0] ?? [''];
}

/** Streams raw CSV records (without terminators) from UTF-8 bytes. A record ends at a
 * newline outside quotes, so quoted line breaks never split a row. The first record
 * keeps no BOM. */
export async function* csvRecords(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '', quoted = false, first = true;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      let start = 0;
      for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code === 34) quoted = !quoted; // Escaped quotes toggle twice.
        else if (code === 10 && !quoted) {
          let record = pending + value.slice(start, index);
          pending = ''; start = index + 1;
          if (record.endsWith('\r')) record = record.slice(0, -1);
          if (first) { first = false; if (record.charCodeAt(0) === 0xfeff) record = record.slice(1); }
          if (record) yield record;
        }
      }
      pending += value.slice(start);
    }
  } finally { reader.releaseLock(); }
  if (quoted) throw new Error('Unterminated quoted GTFS field');
  if (pending.endsWith('\r')) pending = pending.slice(0, -1);
  if (first && pending.charCodeAt(0) === 0xfeff) pending = pending.slice(1);
  if (pending) yield pending;
}

/** Streams raw records with their byte span [offset, end) in the source, end including the
 * terminator. Splitting on bytes is exact: UTF-8 never encodes a newline or quote inside a
 * multibyte character. */
export async function* csvRecordSpans(stream: ReadableStream<Uint8Array>): AsyncGenerator<{ record: string; offset: number; end: number }> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const reader = stream.getReader();
  let pending: Uint8Array = new Uint8Array(0), pendingOffset = 0, quoted = false, first = true;
  const emit = (bytes: Uint8Array, offset: number, end: number) => {
    let length = bytes.length;
    if (length && bytes[length - 1] === 13) length--;
    let record = decoder.decode(bytes.subarray(0, length));
    if (first) { first = false; if (record.charCodeAt(0) === 0xfeff) record = record.slice(1); }
    return { record, offset, end };
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = pending.length ? concat(pending, value) : value;
      let start = 0;
      // Resume scanning after the bytes already examined in the pending prefix.
      for (let index = pending.length; index < chunk.length; index++) {
        const byte = chunk[index]!;
        if (byte === 34) quoted = !quoted;
        else if (byte === 10 && !quoted) {
          if (index > start && !(index - start === 1 && chunk[start] === 13)) yield emit(chunk.subarray(start, index), pendingOffset + start, pendingOffset + index + 1);
          start = index + 1;
        }
      }
      pending = chunk.slice(start); pendingOffset += start;
    }
  } finally { reader.releaseLock(); }
  if (quoted) throw new Error('Unterminated quoted GTFS field');
  if (pending.length) yield emit(pending, pendingOffset, pendingOffset + pending.length);
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(left.length + right.length);
  bytes.set(left); bytes.set(right, left.length);
  return bytes;
}

function parseRows(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char === '\r' && source[index + 1] === '\n') {
      continue;
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error('Unterminated quoted GTFS field');
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
