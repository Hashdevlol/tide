/**
 * Run the $TIDE keeper.
 *   npm run keeper -w server            # schedule: daily at KEEPER_UTC_HOUR (default 15:00 UTC)
 *   npm run keeper -w server -- once    # single run now
 */
import { keeperConfig, runKeeper } from '../src/keeper.ts';

if (process.argv.includes('once')) {
  await runKeeper();
  process.exit(0);
}

function msUntilNext(hour: number) {
  const n = new Date();
  const next = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), hour));
  if (next.getTime() <= n.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - n.getTime();
}

const loop = async () => {
  const wait = msUntilNext(keeperConfig.utcHour);
  console.log(`[keeper] next run in ${(wait / 3600_000).toFixed(2)}h`);
  setTimeout(async () => { await runKeeper(); void loop(); }, wait);
};
if (process.env.KEEPER_RUN_ON_START === 'true') await runKeeper();
void loop();
