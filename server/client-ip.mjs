import { isIP } from 'node:net';
import { requireValue } from './security.mjs';

const CLIENT_IP_HEADER = 'x-finance-client-ip';

// One address only: no proxy chains, ports, brackets, zones or alternate IPv4 syntax.
function canonicalIp(value) {
  if (typeof value !== 'string' || value.includes('%')) return null;
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return null;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

export function createClientIpResolver(trustedProxyIp = '') {
  const proxy = trustedProxyIp === '' ? null : canonicalIp(trustedProxyIp);
  if (trustedProxyIp !== '' && !proxy) throw new Error('TRUST_PROXY_IP 必须是单个明确的代理 IP 地址，不能使用主机名、网段或列表');
  return req => {
    const peer = canonicalIp(req.socket.remoteAddress);
    requireValue(peer, '连接来源地址无效', 403);
    // Direct/local use never trusts a caller-supplied forwarding header.
    if (!proxy) return peer;
    const value = req.headers[CLIENT_IP_HEADER];
    const count = req.rawHeaders.reduce((n, header, index) => n + (index % 2 === 0 && header.toLowerCase() === CLIENT_IP_HEADER ? 1 : 0), 0);
    if (peer !== proxy) {
      requireValue(value === undefined && count === 0, '不接受非受信代理提供的客户端地址', 403);
      return peer;
    }
    const client = canonicalIp(value);
    // Fail closed if the proxy is misconfigured. Caddy must overwrite this header.
    requireValue(count === 1 && client, '受信代理必须提供单一有效的客户端地址', 403);
    return client;
  };
}
