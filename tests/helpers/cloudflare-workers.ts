/** Minimal unit-runtime shim for packages that type-check ExportedHandler alternatives. */
Object.defineProperty(globalThis, 'Cloudflare', {
  configurable: true,
  value: { compatibilityFlags: { global_fetch_strictly_public: true } },
});

export class WorkerEntrypoint<Env = unknown> {
  protected readonly ctx: ExecutionContext;
  protected readonly env: Env;

  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/** Unit-runtime stand-in; workflow logic is tested through runRefresh with a fake step runner. */
export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  protected readonly ctx: ExecutionContext;
  protected readonly env: Env;
  declare readonly params: Params;

  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
