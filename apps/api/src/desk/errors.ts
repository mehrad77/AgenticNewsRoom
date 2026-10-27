/** A desk request that cannot be done, with the HTTP status that says why. */
export class DeskError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  constructor(status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.name = "DeskError";
    this.status = status;
  }
}
