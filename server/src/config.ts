export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://mercantile@localhost:5433/mercantile',
  port: Number(process.env.PORT ?? 4100),
  /**
   * Game-time multiplier. 1 = real time (a 4h cycle takes 4h). Development defaults to 60,
   * so a 4h cycle finishes in 4 minutes.
   */
  timeScale: Number(process.env.TIME_SCALE ?? 60),
  /** Allows POST /api/session/demo to sign in as the seeded demo company. */
  demoLogin: process.env.DEMO_LOGIN !== 'off',
};

/** Real milliseconds for a number of game minutes. */
export const gameMinutesToMs = (minutes: number) => (minutes * 60_000) / config.timeScale;
