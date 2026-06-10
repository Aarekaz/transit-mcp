import { describe, expect, it } from 'vitest';
import { formatStationPredictionsForMcp } from '../../src/mcp/prediction-format';
import type { TransitPrediction } from '../../src/transit/base';

describe('formatStationPredictionsForMcp', () => {
  it('keeps WMATA numeric string countdowns as typed minutes and derives an arrival timestamp', () => {
    const now = new Date('2026-06-10T18:00:00.000Z');
    const predictions: TransitPrediction[] = [
      {
        city: 'dc',
        line: 'BL',
        destination: 'Downtown Largo',
        arrivalTime: '6',
        minutesAway: '6',
        cars: '8'
      },
      {
        city: 'dc',
        line: 'YL',
        destination: 'Huntington',
        arrivalTime: 'ARR',
        minutesAway: 'ARR',
        cars: '6'
      }
    ];

    expect(formatStationPredictionsForMcp(predictions, now)).toEqual([
      {
        line: 'BL',
        destination: 'Downtown Largo',
        minutesAway: 6,
        arrivalTime: '2026-06-10T18:06:00.000Z',
        arrivalStatus: 'SCHEDULED',
        cars: '8',
        direction: null,
        track: null
      },
      {
        line: 'YL',
        destination: 'Huntington',
        minutesAway: null,
        arrivalTime: null,
        arrivalStatus: 'ARRIVING',
        cars: '6',
        direction: null,
        track: null
      }
    ]);
  });
});
