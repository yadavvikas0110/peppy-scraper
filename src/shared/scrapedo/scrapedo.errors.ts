export type ScrapeDoErrorCategory =
  | 'config'
  | 'auth'
  | 'quota'
  | 'blocked'
  | 'timeout'
  | 'target_4xx'
  | 'target_5xx'
  | 'network'
  | 'response';

const RETRYABLE_BY_DEFAULT: Record<ScrapeDoErrorCategory, boolean> = {
  config: false,
  auth: false,
  quota: false,
  blocked: false,
  timeout: true,
  target_4xx: false,
  target_5xx: true,
  network: true,
  response: false,
};

export interface ScrapeDoErrorInit {
  category: ScrapeDoErrorCategory;
  message: string;
  retryable?: boolean;
  statusCode?: number;
  initialStatusCode?: number;
  code?: string;
  attempts?: number;
  retryAfterMs?: number;
}

// Messages must already be masked (see maskSecrets) before reaching this class.
// The raw axios error is deliberately never attached as `cause`: its config.url carries the token.
export class ScrapeDoError extends Error {
  readonly category: ScrapeDoErrorCategory;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly initialStatusCode?: number;
  readonly code?: string;
  readonly retryAfterMs?: number;
  attempts?: number;

  constructor(init: ScrapeDoErrorInit) {
    super(init.message);
    this.name = 'ScrapeDoError';
    this.category = init.category;
    this.retryable = init.retryable ?? RETRYABLE_BY_DEFAULT[init.category];
    this.statusCode = init.statusCode;
    this.initialStatusCode = init.initialStatusCode;
    this.code = init.code;
    this.attempts = init.attempts;
    this.retryAfterMs = init.retryAfterMs;
  }

  toJSON() {
    return {
      name: this.name,
      category: this.category,
      retryable: this.retryable,
      message: this.message,
      statusCode: this.statusCode,
      initialStatusCode: this.initialStatusCode,
      code: this.code,
      attempts: this.attempts,
    };
  }
}

export function isScrapeDoError(err: unknown): err is ScrapeDoError {
  return err instanceof ScrapeDoError;
}

const MASK = '***';
const TOKEN_QUERY_RE = /([?&]token=)[^&\s"'#]*/gi;

export function maskSecrets(text: string, secrets: Array<string | undefined> = []): string {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    out = out.split(secret).join(MASK);
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.split(encoded).join(MASK);
  }
  return out.replace(TOKEN_QUERY_RE, `$1${MASK}`);
}
