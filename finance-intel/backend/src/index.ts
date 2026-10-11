import type { Deps, Env } from './env';
import { runScheduled } from './gmailSync';
import { handleRequest } from './routes';

const deps: Deps = { fetch: (input, init) => fetch(input, init), now: () => Date.now() };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env, deps);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env, deps));
  },
} satisfies ExportedHandler<Env>;
