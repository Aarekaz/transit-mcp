export interface PollingFeed {
  id: string;
  weight: number;
  minIntervalSeconds: number;
  /** Upstream requests per poll, e.g. one per required feed part. */
  requestsPerPoll?: number;
}

export interface PollBudget {
  requestsPerHour: number;
  safetyFactor: number;
  reserveForStatic?: number;
  feeds: PollingFeed[];
}

export function allocatePollIntervals(budget: PollBudget): Record<string, number> {
  const { feeds } = budget;
  const availableRequests = Math.max(
    0,
    budget.requestsPerHour * budget.safetyFactor -
      (budget.reserveForStatic ?? 0),
  );
  const minimumScheduleRequests = feeds.reduce(
    (total, feed) => total + (3600 / feed.minIntervalSeconds) * (feed.requestsPerPoll ?? 1),
    0,
  );

  if (minimumScheduleRequests <= availableRequests) {
    return Object.fromEntries(
      feeds.map((feed) => [feed.id, feed.minIntervalSeconds]),
    );
  }

  const totalWeight = feeds.reduce(
    (total, feed) => total + Math.max(0, feed.weight),
    0,
  );

  return Object.fromEntries(
    feeds.map((feed) => {
      const weight = Math.max(0, feed.weight);
      const allocatedRequests =
        totalWeight > 0 ? (availableRequests * weight) / totalWeight / (feed.requestsPerPoll ?? 1) : 0;
      const budgetedInterval =
        allocatedRequests > 0
          ? Math.ceil(3600 / allocatedRequests)
          : Number.MAX_SAFE_INTEGER;

      return [
        feed.id,
        Math.max(feed.minIntervalSeconds, budgetedInterval),
      ];
    }),
  );
}
