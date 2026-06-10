import type { TransitPrediction } from '../transit/base';

export interface McpStationPrediction {
  line: string;
  destination: string;
  minutesAway: number | null;
  arrivalTime: string | null;
  arrivalStatus: 'ARRIVING' | 'BOARDING' | 'DELAYED' | 'SCHEDULED';
  cars: string | null;
  direction: string | null;
  track: string | null;
}

const STATUS_BY_SENTINEL: Record<string, McpStationPrediction['arrivalStatus']> = {
  ARR: 'ARRIVING',
  BRD: 'BOARDING',
  DLY: 'DELAYED'
};

function parseMinutesAway(value: TransitPrediction['minutesAway']): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null;
}

function normalizeArrivalTime(value: string, minutesAway: number | null, now: Date): string | null {
  const trimmed = value.trim();
  const looksLikeTimestamp = /\d{4}-\d{2}-\d{2}|T|:\d{2}/.test(trimmed);
  const parsed = looksLikeTimestamp ? Date.parse(trimmed) : Number.NaN;
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString();
  }

  if (minutesAway !== null) {
    return new Date(now.getTime() + minutesAway * 60_000).toISOString();
  }

  return null;
}

export function formatStationPredictionsForMcp(
  predictions: TransitPrediction[],
  now = new Date()
): McpStationPrediction[] {
  return predictions.map(prediction => {
    const minutesAway = parseMinutesAway(prediction.minutesAway);
    const sentinel = typeof prediction.minutesAway === 'string'
      ? prediction.minutesAway.trim().toUpperCase()
      : '';

    return {
      line: prediction.line,
      destination: prediction.destination,
      minutesAway,
      arrivalTime: normalizeArrivalTime(prediction.arrivalTime, minutesAway, now),
      arrivalStatus: minutesAway === null
        ? (STATUS_BY_SENTINEL[sentinel] ?? 'SCHEDULED')
        : 'SCHEDULED',
      cars: prediction.cars ?? null,
      direction: prediction.direction ?? null,
      track: prediction.track ?? null
    };
  });
}
