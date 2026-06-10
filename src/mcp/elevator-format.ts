import type { WMATAElevatorIncident } from '../types';

export interface McpElevatorIncident {
  id: string;
  description: string;
  unitName: string;
  unitType: string;
  stationCode: string;
  stationName: string;
  locationDescription: string;
  symptomDescription: string;
  outOfServiceAt: string;
  estimatedReturnToService: string | null;
  lastUpdated: string;
}

export function formatElevatorIncidentsForMcp(
  incidents: WMATAElevatorIncident[]
): McpElevatorIncident[] {
  return incidents.map(incident => ({
    id: incident.UnitName,
    description: incident.SymptomDescription,
    unitName: incident.UnitName,
    unitType: incident.UnitType,
    stationCode: incident.StationCode,
    stationName: incident.StationName,
    locationDescription: incident.LocationDescription,
    symptomDescription: incident.SymptomDescription,
    outOfServiceAt: incident.DateOutOfServ,
    estimatedReturnToService: incident.EstimatedReturnToService,
    lastUpdated: incident.DateUpdated
  }));
}
