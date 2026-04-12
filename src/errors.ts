export class RefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusalError";
  }
}

export function isRefusalError(error: unknown): error is RefusalError {
  return error instanceof RefusalError;
}
