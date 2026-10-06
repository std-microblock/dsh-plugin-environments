// TCP/UDP tunnels over dsh-env-server channels (net.connect / net.listen).
import dgram from 'node:dgram'
import net from 'node:net'
import type { Channel, EnvClient, NetProto } from '@dsh-environments/protocol'

/** An opened tunnel endpoint before it is tracked by the environment. */
export interface OpenedTunnel {
  port: number
  close: () => Promise<void>
}

/** Pump bytes both ways between a channel and a socket; either side closing closes the other. */
export function pipeChannelSocket(channel: Channel, socket: net.Socket): void {
  const r = channel.readable(1)
  r.pipe(socket)
  socket.on('data', d => {
    socket.pause()
    channel.write(d, 0).then(
      () => socket.resume(),
      () => socket.destroy(),
    )
  })
  socket.on('end', () => channel.end(0))
  socket.on('error', () => channel.close())
  socket.on('close', () => channel.close())
  channel.once('close', () => socket.destroy())
}

function udpType(host: string): dgram.SocketType {
  return host.includes(':') ? 'udp6' : 'udp4'
}

/** Listen on a local TCP port; every connection opens `net.connect` to remoteHost:remotePort. */
export async function forwardTcp(
  client: EnvClient,
  localHost: string,
  localPort: number,
  remoteHost: string,
  remotePort: number,
): Promise<OpenedTunnel> {
  const server = net.createServer(socket => {
    socket.pause()
    client.call('net.connect', { host: remoteHost, port: remotePort, proto: 'tcp' }).then(
      ({ ch }) => {
        pipeChannelSocket(client.channel(ch), socket)
        socket.resume()
      },
      () => socket.destroy(),
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(localPort, localHost, resolve)
  })
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

/** Bind a local UDP socket; each distinct peer gets its own `net.connect` udp channel. */
export async function forwardUdp(
  client: EnvClient,
  localHost: string,
  localPort: number,
  remoteHost: string,
  remotePort: number,
): Promise<OpenedTunnel> {
  const sock = dgram.createSocket(udpType(localHost))
  await new Promise<void>((resolve, reject) => {
    sock.once('error', reject)
    sock.bind(localPort, localHost, resolve)
  })
  const peers = new Map<string, { ready: Promise<Channel> }>()
  sock.on('message', (msg, rinfo) => {
    const key = `${rinfo.address}:${rinfo.port}`
    let entry = peers.get(key)
    if (!entry) {
      entry = {
        ready: client.call('net.connect', { host: remoteHost, port: remotePort, proto: 'udp' }).then(({ ch }) => {
          const channel = client.channel(ch)
          channel.readable(1).on('data', (d: Buffer) => sock.send(d, rinfo.port, rinfo.address))
          channel.once('close', () => peers.delete(key))
          return channel
        }),
      }
      peers.set(key, entry)
    }
    const ready = entry.ready
    void (async () => {
      try {
        const channel = await ready
        await channel.write(msg, 0)
      } catch {
        peers.delete(key)
      }
    })()
  })
  return {
    port: sock.address().port,
    close: async () => {
      for (const e of peers.values()) {
        e.ready.then(
          c => c.close(),
          () => {},
        )
      }
      await new Promise<void>(resolve => sock.close(() => resolve()))
    },
  }
}

/** Listen inside the environment and connect every accepted channel to localHost:localPort. */
export async function reverseTunnel(
  client: EnvClient,
  remoteHost: string,
  remotePort: number,
  localHost: string,
  localPort: number,
  proto: NetProto,
): Promise<OpenedTunnel> {
  const { id, port } = await client.call('net.listen', { host: remoteHost, port: remotePort, proto })
  let off: () => void
  if (proto === 'udp') {
    off = client.onListener(id, channel => {
      const sock = dgram.createSocket(udpType(localHost))
      sock.connect(localPort, localHost, () => {
        channel.readable(1).on('data', (d: Buffer) => sock.send(d))
      })
      sock.on('message', msg => {
        channel.write(msg, 0).catch(() => {})
      })
      sock.on('error', () => channel.close())
      channel.once('close', () => {
        try {
          sock.close()
        } catch {
          // already closed
        }
      })
    })
  } else {
    off = client.onListener(id, channel => {
      const socket = net.connect(localPort, localHost)
      socket.once('connect', () => pipeChannelSocket(channel, socket))
      socket.once('error', () => channel.close())
    })
  }
  return {
    port,
    close: async () => {
      off()
      await client.call('net.unlisten', { id }).catch(() => {})
    },
  }
}
