export type TranslationFailureStatus =
  | 'backend_unreachable'
  | 'backend_error'
  | 'invalid_response'
  | 'empty_translation'

/** A translation job failure with the status shown to the user and whether retrying the request can help. */
export class TranslationError extends Error {
  readonly status: TranslationFailureStatus
  readonly retryable: boolean

  constructor (status: TranslationFailureStatus, message: string, retryable: boolean) {
    super(message)
    this.name = 'TranslationError'
    this.status = status
    this.retryable = retryable
  }
}

/** The caption file sent by the client cannot be translated (not WebVTT, or no text). */
export class InvalidSourceError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'InvalidSourceError'
  }
}
