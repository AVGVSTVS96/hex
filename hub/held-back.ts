export class HeldBackError extends Error {
  override readonly name = "HeldBackError";
  readonly seconds: number;

  constructor(message: string, seconds: number, options?: ErrorOptions) {
    super(message, options);
    this.seconds = seconds;
  }
}
