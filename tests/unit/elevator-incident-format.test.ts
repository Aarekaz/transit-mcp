import { describe, expect, it } from 'vitest';
import { formatElevatorIncidentsForMcp } from '../../src/mcp/elevator-format';
import type { WMATAElevatorIncident } from '../../src/types';

describe('formatElevatorIncidentsForMcp', () => {
  it('formats official WMATA elevator outage rows without requiring LinesAffected', () => {
    const incidents: WMATAElevatorIncident[] = [
      {
        UnitName: 'A01E03',
        UnitType: 'ESCALATOR',
        UnitStatus: null,
        StationCode: 'A01',
        StationName: 'Metro Center, G and 11th St Entrance',
        LocationDescription: 'Escalator between street and mezzanine',
        SymptomCode: null,
        SymptomDescription: 'Service Call',
        TimeOutOfService: '1420',
        DisplayOrder: 0,
        DateOutOfServ: '2026-06-10T14:20:00',
        DateUpdated: '2026-06-10T14:20:31',
        EstimatedReturnToService: '2026-06-12T23:59:59'
      }
    ];

    expect(formatElevatorIncidentsForMcp(incidents)).toEqual([
      {
        id: 'A01E03',
        description: 'Service Call',
        unitName: 'A01E03',
        unitType: 'ESCALATOR',
        stationCode: 'A01',
        stationName: 'Metro Center, G and 11th St Entrance',
        locationDescription: 'Escalator between street and mezzanine',
        symptomDescription: 'Service Call',
        outOfServiceAt: '2026-06-10T14:20:00',
        estimatedReturnToService: '2026-06-12T23:59:59',
        lastUpdated: '2026-06-10T14:20:31'
      }
    ]);
  });
});
