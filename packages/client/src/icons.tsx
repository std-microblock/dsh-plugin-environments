import * as React from 'react'
import type { ReactNode, SVGProps } from 'react'
import type { EnvKind } from './types.ts'

const base = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

export interface IconProps {
  size?: number | undefined
}

function Svg({ size = 20, children, ...rest }: IconProps & { children?: ReactNode } & SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} width={size} height={size} aria-hidden="true" {...rest}>
      {children}
    </svg>
  )
}

export function IconEnvironments({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3" y="4" width="12" height="9" rx="1.6" />
      <path d="M7 17h4M9 13v4" />
      <rect x="16" y="9" width="5" height="11" rx="1.4" />
      <path d="M18 17.5h1" />
    </Svg>
  )
}

export function IconLocal({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </Svg>
  )
}

export function IconServer({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3" y="4" width="18" height="7" rx="1.8" />
      <rect x="3" y="13" width="18" height="7" rx="1.8" />
      <path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6" />
    </Svg>
  )
}

export function IconSsh({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3" y="4" width="18" height="16" rx="2.2" />
      <path d="m7 9 3 3-3 3M12.5 15H17" />
    </Svg>
  )
}

export function IconPhone({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="6.5" y="2.5" width="11" height="19" rx="2.4" />
      <path d="M10.5 18.5h3" />
    </Svg>
  )
}

export function IconWindows({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M4 5.5 11 4.4V11H4zM13 4.1 20 3v8h-7zM4 13h7v6.6L4 18.5zM13 13h7v8l-7-1.1z" />
    </Svg>
  )
}

export function IconFolder({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M3 7.2A2.2 2.2 0 0 1 5.2 5h3.6l2 2.2h8A2.2 2.2 0 0 1 21 9.4v7.4A2.2 2.2 0 0 1 18.8 19H5.2A2.2 2.2 0 0 1 3 16.8z" />
    </Svg>
  )
}

export function IconFile({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M7 3h7l4 4v12.5A1.5 1.5 0 0 1 16.5 21h-9A1.5 1.5 0 0 1 6 19.5v-15A1.5 1.5 0 0 1 7.5 3z" />
      <path d="M14 3v4h4" />
    </Svg>
  )
}

export function IconPlus({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  )
}

export function IconRefresh({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M20 11a8 8 0 0 0-14.6-4M4 4v4h4M4 13a8 8 0 0 0 14.6 4M20 20v-4h-4" />
    </Svg>
  )
}

export function IconTrash({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12.2A2 2 0 0 0 9 21h6a2 2 0 0 0 2-1.8L18 7M9 7V4.8A.8.8 0 0 1 9.8 4h4.4a.8.8 0 0 1 .8.8V7" />
    </Svg>
  )
}

export function IconEdit({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="m14.5 5.5 4 4M4 20l1-4.5L16.3 4.2a1.7 1.7 0 0 1 2.4 0l1.1 1.1a1.7 1.7 0 0 1 0 2.4L8.5 19z" />
    </Svg>
  )
}

export function IconPlug({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5" />
    </Svg>
  )
}

export function IconUp({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 19V6M6 11l6-6 6 6" />
    </Svg>
  )
}

export function IconHome({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="m4 11 8-7 8 7M6 10v9h12v-9" />
    </Svg>
  )
}

export function IconChevron({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="m9 6 6 6-6 6" />
    </Svg>
  )
}

export function IconCheck({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Svg>
  )
}

export function IconMount({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 3v10M8 9l4 4 4-4" />
      <rect x="4" y="15" width="16" height="6" rx="1.8" />
      <path d="M8 18h.01" />
    </Svg>
  )
}

export function IconSpinner({ size }: IconProps) {
  return (
    <Svg size={size} className="envx-spin">
      <path d="M12 3a9 9 0 1 0 9 9" />
    </Svg>
  )
}

export function IconReverse({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M4 8h13M13 4l4 4-4 4M20 16H7M11 12l-4 4 4 4" />
    </Svg>
  )
}

export function IconCopy({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h8" />
    </Svg>
  )
}

export const KIND_ICON: Record<EnvKind, (props: IconProps) => React.JSX.Element> = {
  local: IconLocal,
  server: IconServer,
  ssh: IconSsh,
  adb: IconPhone,
  winuser: IconWindows,
  reverse: IconReverse,
}

export function KindIcon({ kind, size = 20 }: { kind: string | undefined; size?: number }) {
  const C =
    (kind !== undefined && Object.hasOwn(KIND_ICON, kind) ? KIND_ICON[kind as EnvKind] : undefined) ?? IconServer
  return <C size={size} />
}
