// Image results: persist bytes as an attachment and show them to image-capable models.
import { agentOf, type PluginContext } from '../host-api.ts'
import type { TextBlock } from './common.ts'

/** The tool-call facts image helpers need. */
export interface ImageExec {
  agent?: unknown
  signal?: AbortSignal | undefined
}

/** Check whether the calling route accepts images (mirrors read_image). */
export async function imageCapable(ctx: PluginContext, exec: ImageExec): Promise<boolean> {
  const agent = agentOf(exec)
  const routed = agent?.session.requestHeader?.()?.config
  const provider = routed?.provider ?? agent?.options?.provider
  const model = routed?.model ?? agent?.options?.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) return true
  try {
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    return !info.inputModalities || info.inputModalities.includes('image')
  } catch {
    return true
  }
}

export const IMAGE_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
    image: {
      type: 'object',
      additionalProperties: true,
      properties: {
        attachmentId: { type: 'string', required: true },
        mediaType: { type: 'string', required: true },
        bytes: { type: 'integer', required: true },
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
      },
    },
  },
} as const

// A type alias (not an interface) so it stays assignable to the schema's JSON record type.
export type ImageAttachment = {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
  originalDimensions?: { width: number; height: number }
}

export interface ImageValue {
  text: string
  image?: ImageAttachment
}

export interface ImageBlock {
  type: 'image'
  attachment: ImageAttachment
}

export const IMAGE_OUTPUT = {
  schema: IMAGE_RESULT_SCHEMA,
  render: (_args: unknown, value: ImageValue): (TextBlock | ImageBlock)[] => {
    const blocks: (TextBlock | ImageBlock)[] = [{ type: 'text', text: value.text }]
    if (value.image) blocks.push({ type: 'image', attachment: value.image })
    return blocks
  },
}

/** Persist PNG/JPEG bytes as an attachment and build the image tool value. */
export async function imageValue(
  ctx: PluginContext,
  exec: ImageExec,
  data: Uint8Array,
  { name, text, mediaType = 'image/png' }: { name: string; text: string; mediaType?: string },
): Promise<ImageValue> {
  const attachments = ctx.get('attachments')
  if (!attachments) return { text: `${text}\n(no attachment store is mounted, so the image cannot be shown)` }
  if (!(await imageCapable(ctx, exec))) {
    return { text: `${text}\n(the current model does not accept images; switch to an image-capable model to view it)` }
  }
  const ref = await attachments.saveImage({ data: new Uint8Array(data), mediaType, name })
  let note = `${text}\n${ref.mediaType} ${ref.width}x${ref.height}`
  if (ref.originalDimensions) {
    const fx = (ref.originalDimensions.width / ref.width).toFixed(3)
    const fy = (ref.originalDimensions.height / ref.height).toFixed(3)
    note += ` (downscaled from ${ref.originalDimensions.width}x${ref.originalDimensions.height}; multiply x by ${fx} and y by ${fy} to get screen coordinates)`
  }
  const image: ImageAttachment = {
    attachmentId: String(ref.attachmentId),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name !== undefined ? { name: ref.name } : {}),
    ...(ref.originalDimensions ? { originalDimensions: { ...ref.originalDimensions } } : {}),
  }
  return { text: note, image }
}
