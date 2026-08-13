import { afterEach, describe, expect, it, vi } from 'vitest';
import { MTAClient } from '../../src/transit/mta-client';
import { WMATAClient } from '../../src/transit/wmata-client';

const fetchMock = vi.fn<typeof fetch>();

describe('transit request cancellation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes the caller signal to a direct WMATA fetch', async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(Response.json({ Stations: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await new WMATAClient('key').getStations(controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal })
    );
  });

  it('stops the MTA multi-feed loop after the caller aborts', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async (_url, init) => {
      controller.abort();
      expect(init?.signal).toBe(controller.signal);
      throw controller.signal.reason;
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new MTAClient().getStationPredictions('127', controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes the caller signal to the MTA incidents fetch', async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(Response.json({ entity: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await new MTAClient().getIncidents(controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal })
    );
  });
});
