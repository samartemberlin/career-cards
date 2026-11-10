// Minimal type stubs for runtime deps that ship without bundled TypeScript declarations.

declare module 'js-yaml' {
  export function load(input: string, options?: object): unknown;
  export function dump(obj: unknown, options?: object): string;
}
