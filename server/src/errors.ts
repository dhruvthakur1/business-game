/** An error that maps to an HTTP status and a message safe to show players. */
export class GameError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new GameError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string) => new GameError(400, 'bad_request', message);
export const conflict = (code: string, message: string) => new GameError(409, code, message);
export const insufficientFunds = () => conflict('insufficient_funds', 'Not enough cash for this action.');

/** Postgres check-constraint failures on company balances mean the player cannot afford something. */
export function mapDbError(err: unknown): unknown {
  const e = err as { code?: string; constraint?: string };
  if (e?.code === '23514' && e.constraint === 'company_accounts_not_negative') return insufficientFunds();
  if (e?.code === '23514' && e.constraint === 'inventory_qty_check') return conflict('insufficient_goods', 'Not enough goods in the warehouse.');
  return err;
}
