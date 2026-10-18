import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/types';
import { createRegionalTransitService } from '../../src/transit/gtfs/realtime/service';
import { memoryStorage } from '../helpers/realtime-fixture';

describe('regional transit service storage boundary', () => {
  it('fails closed when the artifact binding is absent', async () => {
    await expect(createRegionalTransitService({} as Env).getRoutes()).rejects.toThrow('artifact is not configured');
  });
  it('fails closed when the v2 artifact pointer is absent', async () => {
    const db = memoryStorage();
    await expect(createRegionalTransitService({ TRANSIT_ARTIFACTS: db.bucket } as Env).getRoutes()).rejects.toThrow('artifact is unavailable');
  });
  it('does not follow an invalid artifact pointer to arbitrary objects', async () => {
    const db = memoryStorage();
    db.objects.set('artifacts/sfbay/v2/current.json', new TextEncoder().encode('{"current":"untrusted/path"}'));
    await expect(createRegionalTransitService({ TRANSIT_ARTIFACTS: db.bucket } as Env).getRoutes()).rejects.toThrow('Invalid artifact version');
    expect(db.reads).toEqual(['artifacts/sfbay/v2/current.json']);
  });
});
