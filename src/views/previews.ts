// Previews: a view rendered once, held in memory at an unguessable token for
// a short while, never persisted. The authoring loop's "look before you pin":
// the agent previews, the human opens the URL, they tune, then pin_view takes
// the identical spec. Tokens are handles, not credentials — the route that
// serves them is authenticated like /views.

import { randomBytes } from "node:crypto";

import type { ViewSnapshot, ViewSpec } from "./model.js";

export interface ViewPreview {
  token: string;
  spec: ViewSpec;
  snapshot: ViewSnapshot;
  createdAt: string;
  expiresAt: string;
}

export interface PreviewStoreOptions {
  ttlMs: number;
  /** Oldest previews are evicted past this many live ones. */
  max: number;
  now?: () => number;
}

export class PreviewStore {
  private readonly previews = new Map<string, ViewPreview>();
  private readonly now: () => number;

  constructor(private readonly options: PreviewStoreOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  put(spec: ViewSpec, snapshot: ViewSnapshot): ViewPreview {
    this.sweep();
    while (this.previews.size >= this.options.max) {
      const oldest = this.previews.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.previews.delete(oldest.value);
    }
    const now = this.now();
    const preview: ViewPreview = {
      token: randomBytes(16).toString("base64url"),
      spec,
      snapshot,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.options.ttlMs).toISOString(),
    };
    this.previews.set(preview.token, preview);
    return preview;
  }

  get(token: string): ViewPreview | undefined {
    const preview = this.previews.get(token);
    if (preview === undefined) {
      return undefined;
    }
    if (Date.parse(preview.expiresAt) <= this.now()) {
      this.previews.delete(token);
      return undefined;
    }
    return preview;
  }

  get size(): number {
    this.sweep();
    return this.previews.size;
  }

  clear(): void {
    this.previews.clear();
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, preview] of this.previews) {
      if (Date.parse(preview.expiresAt) <= now) {
        this.previews.delete(token);
      }
    }
  }
}
