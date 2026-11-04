/** A desk request that cannot be done, with the HTTP status that says why. */
export class DeskError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 429 | 502 | 503;
  /** Each problem, when the request was refused for several (role chains). */
  readonly problems?: string[];
  constructor(
    status: 400 | 403 | 404 | 409 | 429 | 502 | 503,
    message: string,
    problems?: string[],
  ) {
    super(message);
    this.name = "DeskError";
    this.status = status;
    this.problems = problems;
  }
}
