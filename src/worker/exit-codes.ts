/**
 * The exit codes of `harness worker`, for the service manager above it.
 * 0 and 1 are restartable: a clean stop, and a stop that a restart may cure (the MCP child is gone, a container is not provably stopped).
 * 78 (EX_CONFIG) is not: the same start would fail the same way, so restarting only repeats it. A service manager is told not to restart on it.
 */
export const EXIT_STOPPED = 0
export const EXIT_RESTART = 1
export const EXIT_NO_RESTART = 78

export type ExitCode = typeof EXIT_STOPPED | typeof EXIT_RESTART | typeof EXIT_NO_RESTART
