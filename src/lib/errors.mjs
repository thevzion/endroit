export class EndroitError extends Error {
  constructor(code, message, options = {}) {
    super(message, { cause: options.cause })
    this.name = 'EndroitError'
    this.code = code
    this.exitCode = options.exitCode ?? 2
    this.details = options.details ?? null
  }
}

export function asEndroitError(error) {
  if (error instanceof EndroitError) return error
  return new EndroitError('internal_error', error?.message ?? String(error), {
    exitCode: 1,
    cause: error,
  })
}
