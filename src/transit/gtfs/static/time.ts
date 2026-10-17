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
