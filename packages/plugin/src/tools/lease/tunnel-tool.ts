// Network tunnels of a borrowed environment.
import type { TunnelInfo } from '../../env/types.ts'
import { TEXT_OUTPUT } from '../common.ts'
import type { LeaseToolContext } from './context.ts'

function describeTunnel(t: TunnelInfo): string {
  const route =
    t.kind === 'forward'
      ? `host 127.0.0.1:${t.localPort} → env ${t.remoteHost}:${t.remotePort}`
      : `env ${t.remoteHost}:${t.remotePort} → host ${t.localHost}:${t.localPort}`
  return `${t.id}: ${route} (${t.proto})`
}

export function addTunnelTool({ env, label: name, add }: LeaseToolContext): void {
  add({
    name: 'tunnel',
    description: `Manage network tunnels for ${name}. direction "to_env" makes a port of the environment reachable at 127.0.0.1:<local_port> on the harness host (like ssh -L); "from_env" makes a host port reachable inside the environment at <env_host>:<env_port> (like ssh -R; e.g. let a phone reach a dev server). UDP needs a dsh-env-server based environment.`,
    parameters: {
      action: { type: 'string', enum: ['open', 'close', 'list'], required: true, description: 'What to do.' },
      direction: { type: 'string', enum: ['to_env', 'from_env'], description: 'Tunnel direction (for open).' },
      env_port: { type: 'integer', description: 'Port inside the environment (0 = pick one, for from_env).' },
      env_host: { type: 'string', description: 'Host inside the environment (default 127.0.0.1).' },
      local_port: { type: 'integer', description: 'Port on the harness host (0 = pick one, for to_env).' },
      protocol: { type: 'string', enum: ['tcp', 'udp'], description: 'Default tcp.' },
      id: { type: 'string', description: 'Tunnel id (for close).' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      if (args.action === 'list') return env.listTunnels().map(describeTunnel).join('\n') || 'No tunnels'
      if (args.action === 'close') {
        const t = env.tunnels.get(args.id ?? '')
        if (!t) throw new Error(`unknown tunnel ${args.id}`)
        await t.close()
        return `closed ${args.id}`
      }
      const proto = args.protocol ?? 'tcp'
      if (args.direction === 'from_env') {
        if (!args.local_port) throw new Error('local_port (the host port to expose) is required')
        const t = await env.reverse({
          remoteHost: args.env_host ?? '127.0.0.1',
          remotePort: args.env_port ?? 0,
          localHost: '127.0.0.1',
          localPort: args.local_port,
          proto,
        })
        return `opened ${describeTunnel(t)}`
      }
      if (!args.env_port) throw new Error('env_port is required')
      const t = await env.forward({
        localHost: '127.0.0.1',
        localPort: args.local_port ?? 0,
        remoteHost: args.env_host ?? '127.0.0.1',
        remotePort: args.env_port,
        proto,
      })
      return `opened ${describeTunnel(t)}`
    },
  })
}
