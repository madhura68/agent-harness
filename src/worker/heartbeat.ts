import type { ControlChannel } from './control.js'

/**
 * Sends `job_heartbeat` every `ms` until the returned stop function is called. A refusal (false) means the
 * job is no longer ours. A thrown call proves nothing by itself; two in a row are treated as lost, so one
 * transient hiccup does not abandon a healthy job. `onLost` fires at most once, and never after stop:
 * a late answer to a beat that was in flight when the caller closed the job does not count.
 */
export function startHeartbeat(control: Pick<ControlChannel, 'heartbeat'>, jobId: string, ms: number, onLost: () => void): () => void {
  let failures = 0
  let stopped = false
  let lost = false
  const markLost = () => {
    if (stopped || lost) return
    lost = true
    onLost()
  }
  const timer = setInterval(() => {
    void control.heartbeat(jobId).then(
      (ok) => {
        failures = 0
        if (!ok) markLost()
      },
      () => {
        if (++failures >= 2) markLost()
      },
    )
  }, ms)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
