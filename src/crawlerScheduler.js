export function createNonOverlappingScheduler(
  run,
  {
    intervalMs = 120_000,
    label = 'scheduler',
    logger = console,
  } = {}
) {
  let running = false;
  let timer = null;

  async function tick(trigger = 'internal') {
    if (running) {
      logger.log(`[${label}] skipped trigger=${trigger} reason=tick_in_progress`);
      return { skipped: true, reason: 'tick_in_progress' };
    }

    running = true;
    try {
      const result = await run(trigger);
      if (result?.queued) {
        logger.log(
          `[${label}] trigger=${trigger} queued=true type=${result.type || 'unknown'}`
        );
      } else if (result?.reason && result.reason !== 'user_active') {
        logger.log(
          `[${label}] trigger=${trigger} queued=false reason=${result.reason}`
        );
      }
      return result;
    } catch (err) {
      logger.warn(`[${label}] trigger=${trigger} error=${err?.message || err}`);
      return { queued: false, error: true, reason: 'exception' };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return timer;
    timer = setInterval(() => {
      void tick('internal');
    }, Math.max(30_000, Number(intervalMs) || 120_000));
    timer.unref?.();
    return timer;
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    tick,
    start,
    stop,
    isRunning: () => running,
    isStarted: () => Boolean(timer),
  };
}
