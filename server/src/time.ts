import { config } from './config';

const REAL_DAY_MS = 86_400_000;

/** Real milliseconds in one game day. */
export const gameDayMs = () => REAL_DAY_MS / config.timeScale;

/** Current game-day number. Day boundaries are where the daily close runs. */
export const gameDay = (now = Date.now()) => Math.floor((now * config.timeScale) / REAL_DAY_MS);

/** Real milliseconds for a number of game hours. */
export const gameHoursMs = (hours: number) => (hours * 3_600_000) / config.timeScale;

/** Real time at which a game day starts. */
export const gameDayStart = (day: number) => new Date((day * REAL_DAY_MS) / config.timeScale);
