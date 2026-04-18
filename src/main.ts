import type { RegisterServerOptions } from '@peertube/peertube-types'

async function register ({ peertubeHelpers }: RegisterServerOptions) {
  const { logger } = peertubeHelpers
  logger.info('[subtitle-translator] plugin registered')
}

async function unregister () {
  return
}

module.exports = {
  register,
  unregister
}
