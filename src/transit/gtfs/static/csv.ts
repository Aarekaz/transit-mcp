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
