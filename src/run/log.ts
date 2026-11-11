export type RunLog = {
  log(line: string): void;
  lines(): string[];
  redact(text: string): string;
};

const SECRET_NAME_RE = /KEY|TOKEN|SECRET/;

/** Returns the values of env vars whose names match /KEY|TOKEN|SECRET/ and whose values are ≥ 8 chars. */
export function secretsFromEnv(env: Record<string, string | undefined>): string[] {
  const result: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_NAME_RE.test(key) && value !== undefined && value.length >= 8) {
      result.push(value);
    }
  }
  return result;
}

/** Creates a log buffer that redacts secrets before writing to the sink and before buffering.
 *  @param o.sink - receives each redacted line
 *  @param o.secrets - any occurrence of these strings is replaced with '***'
 *  @param o.keep - max lines kept in memory (default 200) */
export function createRunLog(o: {
  sink: (line: string) => void;
  secrets: string[];
  keep?: number;
}): RunLog {
  const keep = o.keep ?? 200;
  const buffer: string[] = [];

  function redact(text: string): string {
    let result = text;
    for (const secret of o.secrets) {
      // split/join avoids escaping special regex chars in secret values
      const parts = result.split(secret);
      if (parts.length > 1) result = parts.join('***');
    }
    return result;
  }

  return {
    log(line: string): void {
      const redacted = redact(line);
      o.sink(redacted);
      buffer.push(redacted);
      if (buffer.length > keep) buffer.shift();
    },
    lines(): string[] {
      return [...buffer];
    },
    redact,
  };
}
