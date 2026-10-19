import type { ServiceCalendar } from '../gtfs/static/artifact';
import { parseServiceDate } from '../gtfs/static/time';

const DAY = 86_400_000;
export const MAX_STOP_TIME_SECONDS = 2 * (999 * 3600 + 3599);
export interface ServiceDay { serviceDate: string; startTime: string; elapsedSeconds: number }

// Formatters are immutable and costly to construct; one per timezone is reused.
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let format = formatters.get(timezone);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    } catch { throw new Error('Invalid agency timezone'); }
    formatters.set(timezone, format);
  }
  return format;
}

function civilParts(milliseconds: number, format: Intl.DateTimeFormat): Record<string, string> {
  return Object.fromEntries(format.formatToParts(milliseconds).map(part => [part.type, part.value]));
}

function offsetAt(milliseconds: number, format: Intl.DateTimeFormat): number {
  const p = civilParts(milliseconds, format);
  return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`) - Math.floor(milliseconds / 1000) * 1000;
}

/** No host timezone or implicit wall clock is permitted at the query boundary. */
export function parseInstant(instant: string): number {
  const match = /^(\d{4}-\d{2}-\d{2})T([0-2]\d):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(instant);
  if (!match) throw new Error('Invalid instant: ISO timestamp with explicit UTC offset required');
  try { parseServiceDate(match[1]!.replaceAll('-', '')); } catch { throw new Error('Invalid instant date'); }
  const milliseconds = Date.parse(instant);
  if (Number(match[2]) > 23 || !Number.isFinite(milliseconds)) throw new Error('Invalid instant');
  return milliseconds;
}

export function formatInstant(milliseconds: number, timezone: string): string {
  const format = formatter(timezone), p = civilParts(milliseconds, format);
  const offsetMinutes = offsetAt(milliseconds, format) / 60_000;
  const absolute = Math.abs(offsetMinutes), pad = (n: number) => String(n).padStart(2, '0');
  const fraction = ((milliseconds % 1000) + 1000) % 1000;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${fraction ? `.${String(fraction).padStart(3, '0')}` : ''}${offsetMinutes < 0 ? '-' : '+'}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

export function serviceDateAtInstant(milliseconds: number, timezone: string): string {
  const p = civilParts(milliseconds, formatter(timezone));
  return `${p.year}${p.month}${p.day}`;
}

export function shiftServiceDate(serviceDate: string, days: number): string {
  return new Date(parseServiceDate(serviceDate).getTime() + days * DAY).toISOString().slice(0, 10).replaceAll('-', '');
}

/** GTFS seconds count elapsed time from local noon minus twelve elapsed hours.
 * Local midnight is a different instant on DST transition dates. */
export function serviceDayOrigin(serviceDate: string, timezone: string): number {
  const civilNoon = parseServiceDate(serviceDate).getTime() + DAY / 2;
  const format = formatter(timezone);
  let noon = civilNoon;
  for (let attempt = 0; attempt < 4; attempt++) {
    const adjusted = civilNoon - offsetAt(noon, format);
    if (adjusted === noon) return noon - DAY / 2;
    noon = adjusted;
  }
  throw new Error('Unsupported agency service date');
}

export function serviceInstant(serviceDate: string, seconds: number, timezone: string): string {
  return formatInstant(serviceDayOrigin(serviceDate, timezone) + seconds * 1000, timezone);
}

/** Candidates that can contribute at this instant, oldest first. The loader
 * supplies the compiler's bound; the two-argument form covers normal overnight service. */
export function serviceDaysForInstant(instant: string, agencyTimezone: string, maxStopTimeSeconds = 172799): ServiceDay[] {
  const milliseconds = parseInstant(instant);
  if (!Number.isInteger(maxStopTimeSeconds) || maxStopTimeSeconds < 0 || maxStopTimeSeconds > MAX_STOP_TIME_SECONDS) throw new Error('Invalid timetable bound');
  const today = serviceDateAtInstant(milliseconds, agencyTimezone);
  const result: ServiceDay[] = [];
  for (let day = -Math.ceil(maxStopTimeSeconds / 86400) - 1; day <= 1; day++) {
    const serviceDate = shiftServiceDate(today, day), origin = serviceDayOrigin(serviceDate, agencyTimezone);
    const elapsedSeconds = (milliseconds - origin) / 1000;
    if (elapsedSeconds >= 0 && elapsedSeconds <= maxStopTimeSeconds) result.push({ serviceDate, startTime: formatInstant(origin, agencyTimezone), elapsedSeconds });
  }
  return result;
}

export function isServiceActive(calendar: ServiceCalendar, serviceDate: string): boolean {
  const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
  if (calendar.exceptions[serviceDate] === 1) return true;
  if (calendar.exceptions[serviceDate] === 2) return false;
  return serviceDate >= calendar.startDate && serviceDate <= calendar.endDate && calendar[weekday[parseServiceDate(serviceDate).getUTCDay()]!];
}
