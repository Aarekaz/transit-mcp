export interface GtfsTime {
  hours: number;
  minutes: number;
  seconds: number;
  totalSeconds: number;
}

export function parseGtfsTime(value: string): GtfsTime {
  const match = /^(\d{1,3}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid GTFS time: ${value}`);
  const [, hourText, minuteText, secondText] = match;
  const hours = Number(hourText);
  const minutes = Number(minuteText);
  const seconds = Number(secondText);
  if (minutes > 59 || seconds > 59) throw new Error(`Invalid GTFS time: ${value}`);
  return { hours, minutes, seconds, totalSeconds: hours * 3600 + minutes * 60 + seconds };
}

/** Calendar dates are civil dates, not instants in an agency timezone. */
export function parseServiceDate(value: string): Date {
  if (!/^\d{8}$/.test(value)) throw new Error('Invalid GTFS service date');
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso) throw new Error('Invalid GTFS service date');
  return date;
}
