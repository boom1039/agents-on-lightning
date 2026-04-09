export function getSocketAddress(req) {
  return req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || '';
}
