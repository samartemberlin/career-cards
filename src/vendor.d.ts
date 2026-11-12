// Minimal type stubs for runtime deps that ship without bundled TypeScript declarations.

declare module 'js-yaml' {
  export function load(input: string, options?: object): unknown;
  export function dump(obj: unknown, options?: object): string;
}

// career-ops/liveness-core.mjs: pure page-liveness classifier (no imports, no I/O).
// Resolved at runtime via package.json "imports" { "#career-ops/liveness-core.mjs": ... }.
declare module '#career-ops/liveness-core.mjs' {
  export type LivenessVerdict = { result: 'active' | 'expired' | 'uncertain'; code: string; reason: string };
  export function classifyLiveness(opts: {
    status?: number;
    requestedUrl?: string;
    finalUrl?: string;
    bodyText?: string;
    applyControls?: string[];
  }): LivenessVerdict;
}

// career-ops/liveness-api.mjs: ATS-based liveness check; used only in liveness-child.ts.
// Resolved at runtime via package.json "imports" { "#career-ops/liveness-api.mjs": ... }.
declare module '#career-ops/liveness-api.mjs' {
  export function checkLivenessViaApi(url: string): Promise<{ result: 'active' | 'expired' | 'uncertain'; code: string; reason: string } | null>;
}

