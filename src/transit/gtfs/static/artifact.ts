import type { TransitMode } from './modes';

export interface ArtifactStop {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  locationType: number;
  parentStationId?: string;
}

export interface ArtifactRoute {
  id: string;
  shortName: string;
  longName: string;
  mode: TransitMode;
  color?: string;
}

export interface StaticTransitArtifact {
  schemaVersion: 1;
  region: 'sfbay';
  sourceVersion: string;
  generatedAt: string;
  stops: ArtifactStop[];
  routes: ArtifactRoute[];
  stopRoutes: Record<string, string[]>;
}

type ArtifactInput = Omit<StaticTransitArtifact, 'schemaVersion'>;

function sortedRecord(values: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(values)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entries]) => [key, [...new Set(entries)].sort()]),
  );
}

export function createStaticArtifact(input: ArtifactInput): StaticTransitArtifact {
  return {
    schemaVersion: 1,
    region: input.region,
    sourceVersion: input.sourceVersion,
    generatedAt: input.generatedAt,
    stops: [...input.stops].sort((left, right) => left.id.localeCompare(right.id)),
    routes: [...input.routes].sort((left, right) => left.id.localeCompare(right.id)),
    stopRoutes: sortedRecord(input.stopRoutes),
  };
}

export function searchStops(
  artifact: StaticTransitArtifact,
  query: string,
  limit = 20,
): ArtifactStop[] {
  const normalized = query.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
  if (!normalized || limit <= 0) return [];

  return artifact.stops
    .filter(stop => (
      stop.id.toLocaleLowerCase('en-US').includes(normalized)
      || stop.name.toLocaleLowerCase('en-US').includes(normalized)
    ))
    .sort((left, right) => {
      const leftParentRank = left.locationType === 1 ? 0 : 1;
      const rightParentRank = right.locationType === 1 ? 0 : 1;
      return leftParentRank - rightParentRank
        || left.name.localeCompare(right.name)
        || left.id.localeCompare(right.id);
    })
    .slice(0, limit);
}
