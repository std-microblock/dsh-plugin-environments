declare module '*.css' {
  /** Stylesheet text (bundled with esbuild's `text` loader). */
  const css: string
  export default css
}
