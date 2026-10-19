import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../../../types';
import { runRefresh, type RefreshOutcome, type RefreshParams, type StepRunner } from './refresh';

/** Durable, retried schedule rebuild. Each step stays within one Worker invocation's
 * CPU and memory: one feed scan, then one service date per step. */
export class TransitRefreshWorkflow extends WorkflowEntrypoint<Env, RefreshParams> {
  override async run(event: WorkflowEvent<RefreshParams>, step: WorkflowStep): Promise<RefreshOutcome> {
    const runner: StepRunner = {
      // Every step result in runRefresh is plain JSON data, which Workflows persists.
      do: <T>(name: string, run: () => Promise<T>) => step.do(name, { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' }, timeout: '10 minutes' },
        run as unknown as () => Promise<Rpc.Serializable<T>>) as unknown as Promise<T>,
      sleep: (name, milliseconds) => step.sleep(name, milliseconds),
    };
    return runRefresh(this.env, event.payload, runner);
  }
}
