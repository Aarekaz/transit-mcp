import { describe, expect, it } from 'vitest';
import { changesServiceOn } from '../../src/transit/gtfs/refresh/near-term';
import { NYC_FILES } from '../helpers/dc-nyc-realtime';
import { zip } from '../helpers/zip';

// Monday 19 October and the days around it; "Later" runs only on Tuesday 27 October.
const NEAR = ['20261018', '20261019', '20261020'];
const base = { ...NYC_FILES, 'calendar_dates.txt': 'service_id,date,exception_type\nLater,20261027,1\n',
  'trips.txt': `${NYC_FILES['trips.txt']}F,LATER-F-1,Later,Coney Island-Stillwell Av,1\n`,
  'stop_times.txt': `${NYC_FILES['stop_times.txt']}LATER-F-1,10:00:00,10:00:00,D19S,1\nLATER-F-1,10:30:00,10:30:00,132S,2\n` } as Record<string, string>;
const withTrip = (id: string, service: string) => ({ ...base, 'trips.txt': `${base['trips.txt']}F,${id},${service},Coney Island-Stillwell Av,1\n`,
  'stop_times.txt': `${base['stop_times.txt']}${id},11:00:00,11:00:00,D19S,1\n${id},11:30:00,11:30:00,132S,2\n` });
const changes = async (next: Record<string, string>, dates = NEAR) => changesServiceOn(await zip(base), await zip(next), dates);

describe('which service days a new archive changes', () => {
  it('sees no change in the same tables zipped again', async () => {
    expect(await changesServiceOn(await zip(base), await zip(Object.fromEntries(Object.entries(base).reverse()), 0), NEAR)).toBe(false);
  });

  it('places added and removed trips on the days their service runs', async () => {
    expect(await changes(withTrip('LATER-F-2', 'Later'))).toBe(false);
    expect(await changes(withTrip('LATER-F-2', 'Later'), ['20261027'])).toBe(true);
    expect(await changes(withTrip('WEEKDAY-F-2', 'Weekday'))).toBe(true);
    const removed = { ...base, 'trips.txt': base['trips.txt']!.replace('F,LATER-F-1,Later,Coney Island-Stillwell Av,1\n', ''),
      'stop_times.txt': base['stop_times.txt']!.split('\n').filter(line => !line.startsWith('LATER-F-1')).join('\n') };
    expect(await changes(removed)).toBe(false);
  });

  it('counts an edited trip on both its old and its new service', async () => {
    expect(await changes({ ...base, 'trips.txt': base['trips.txt']!.replace('F,LATER-F-1,Later,', 'F,LATER-F-1,Weekday,') })).toBe(true);
    expect(await changes({ ...base, 'trips.txt': base['trips.txt']!.replace('Later,Coney Island-Stillwell Av', 'Later,Coney Island') })).toBe(false);
  });

  it('treats what trips.txt cannot place as near-term', async () => {
    // Stop times edited without a trips.txt change could be any trip's.
    expect(await changes({ ...base, 'stop_times.txt': base['stop_times.txt']!.replace('LATER-F-1,10:30:00,10:30:00', 'LATER-F-1,10:31:00,10:31:00') })).toBe(true);
    expect(await changes({ ...withTrip('LATER-F-2', 'Later'), 'stops.txt': `${base['stops.txt']}999,New stop,40.7,-73.9,1,\n` })).toBe(true);
    expect(await changes({ ...withTrip('LATER-F-2', 'Later'), 'calendar_dates.txt': 'service_id,date,exception_type\nLater,20261019,1\n' })).toBe(true);
    // A trip on a service the calendar does not know.
    expect(await changes(withTrip('ODD-F-1', 'Unknown'))).toBe(true);
  });
});
