import type {
  AdapterContext,
  WebFetchRequest,
  WebFetchResult,
  WebProvider,
  WebSearchHit,
  WebSearchRequest,
} from "@rakazo/adapter-kit";
import { clampOffset, pageWindow } from "./web-limits.js";

/** In-memory web provider for offline tests. Never hits the network. */
export class FakeWebProvider implements WebProvider {
  searchHits: WebSearchHit[] = [];
  fetchResult: WebFetchResult = {
    url: "https://example.test/page",
    title: "Example",
    text: "Hello from fake web",
    truncated: false,
  };
  lastSearch?: WebSearchRequest;
  lastFetch?: WebFetchRequest;
  searchError?: Error;
  fetchError?: Error;

  describe() {
    return {
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        search: true,
        fetch: true,
        keyless: true,
        native: false,
        readability: true,
      },
    };
  }

  async search(request: WebSearchRequest, _context: AdapterContext): Promise<WebSearchHit[]> {
    this.lastSearch = request;
    if (this.searchError) throw this.searchError;
    const limit = request.maxResults ?? this.searchHits.length;
    return this.searchHits.slice(0, limit);
  }

  async fetch(request: WebFetchRequest, _context: AdapterContext): Promise<WebFetchResult> {
    this.lastFetch = request;
    if (this.fetchError) throw this.fetchError;
    const offset = clampOffset(request.offset);
    const rest = this.fetchResult.text.slice(offset);
    const maxChars = request.maxChars ?? rest.length;
    const window = pageWindow(rest, maxChars, offset);
    return {
      ...this.fetchResult,
      url: request.url || this.fetchResult.url,
      text: window.text,
      truncated: window.truncated || this.fetchResult.truncated,
    };
  }
}
