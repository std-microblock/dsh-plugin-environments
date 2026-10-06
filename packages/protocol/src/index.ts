// @dsh-environments/protocol: wire format, message types and the Node client for dsh-env-server.
export * from './types.ts'
export { EnvError, errorCode, errorMessage } from './errors.ts'
export { encodeFrame, FrameDecoder, type FrameHandler } from './frame.ts'
export { Channel, type ChannelEvents, type ChannelHost, type ChannelOutcome } from './channel.ts'
export {
  EnvClient,
  type AcceptEvent,
  type EnvClientEvents,
  type EnvClientOptions,
  type ListenerHandler,
  type Response,
  type Transport,
} from './client.ts'
export { CallbackTransport, childTransport, type StdioChild } from './transports.ts'
export {
  deriveKeys,
  generateSecret,
  MAX_RECORD,
  RecordCipher,
  secureInitiate,
  secureRespond,
  SECURE_VERSION,
  type InitiateOptions,
  type SecureKeys,
} from './secure.ts'
export {
  encodeWsFrame,
  WsDecoder,
  wsAccept,
  wsAcceptKey,
  wsConnect,
  type WsConnectOptions,
  type WsFrame,
} from './websocket.ts'
