/**
 * Ambient declarations for the two Deno globals the Functions actually use:
 * `Deno.env.get` (functions/binding.ts) and `Deno.serve` (functions/index.ts).
 *
 * This exists because `functions/` is excluded from the app's tsconfig — it is
 * server code that must never enter the browser bundle — which also meant the
 * whole directory was never typechecked locally. `deno check` cannot fill the
 * gap either: Deno is not installed on this machine. So a type error in the
 * Function surfaced only when the edge runtime threw at request time, in
 * production, in front of a judge.
 *
 * Deliberately NOT a general Deno shim. If a Function starts using
 * `Deno.readFile`, `Deno.connect` or anything else, this file must grow to admit
 * it — and that friction is the point. It forces a new platform capability to be
 * declared somewhere visible instead of appearing silently in code that only ever
 * runs in production.
 */
declare namespace Deno {
  /**
   * Environment access. On this platform it is where `QODER_PAT` lives, so the
   * values are secrets: never logged, never returned in a response body, never
   * passed into a prompt or a browser-visible payload.
   */
  const env: {
    get(key: string): string | undefined;
  };

  /**
   * The handler contract the Functions satisfy. Note what it does NOT include:
   * no second `info` argument, no streaming-upgrade helper. `functions/index.ts`
   * calls `Deno.serve(handler)` with a plain request-to-response function, and
   * this type is written to match that call rather than Deno's full overload set.
   */
  type ServeHandler = (request: Request) => Response | Promise<Response>;

  /** Return value ignored: the platform owns the server's lifetime, not us. */
  function serve(handler: ServeHandler): unknown;
}
