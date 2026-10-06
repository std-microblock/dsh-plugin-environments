// Screen capture and input injection (computer use) of a borrowed environment.
import { TEXT_OUTPUT } from '../common.ts'
import { IMAGE_OUTPUT, imageValue } from '../image.ts'
import type { LeaseToolContext } from './context.ts'

export function addScreenTools({ ctx, env, alias: a, label: name, add }: LeaseToolContext): void {
  if (env.hasCap('screenshot')) {
    add({
      name: 'screenshot',
      description: `Capture the screen of ${name}. Coordinates in the image map to ${a}__input coordinates (scale them back if the image was downscaled).`,
      parameters: {},
      output: IMAGE_OUTPUT,
      async execute(_args, exec) {
        const shot = await env.screenshot({ signal: exec.signal })
        return imageValue(ctx, exec, shot.png, {
          name: `${a}-screenshot.png`,
          text: `Screenshot of ${name}: ${shot.width}x${shot.height} screen pixels.`,
        })
      },
    })
  }

  if (env.hasCap('input')) {
    add({
      name: 'input',
      description: `Send pointer/keyboard input to ${name}. Actions run in order. Coordinates are screen pixels.${env.kind === 'adb' ? ' On Android, "click" taps, "swipe" drags from (x,y) to (x2,y2), "key" accepts Android key names such as home, back, enter, app_switch.' : ' "key" accepts combos such as "ctrl+s", "alt+tab", "enter".'}`,
      parameters: {
        actions: {
          type: 'array',
          required: true,
          description: 'Actions to perform.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: {
                type: 'string',
                enum: ['click', 'move', 'swipe', 'scroll', 'type', 'key', 'wait'],
                required: true,
              },
              x: { type: 'number' },
              y: { type: 'number' },
              x2: { type: 'number' },
              y2: { type: 'number' },
              button: { type: 'string', enum: ['left', 'right', 'middle'] },
              double: { type: 'boolean' },
              long: { type: 'boolean' },
              dx: { type: 'number' },
              dy: { type: 'number' },
              text: { type: 'string' },
              key: { type: 'string' },
              ms: { type: 'number' },
            },
          },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        await env.input(args.actions, { signal: exec.signal })
        return `performed ${args.actions.length} action${args.actions.length === 1 ? '' : 's'}`
      },
    })
  }
}
