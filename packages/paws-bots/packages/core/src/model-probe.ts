export type ModelProbeState = {
  models: string[];
  baseUrl: string | null;
  probing: boolean;
};

export const initialModelProbeState: ModelProbeState = {
  models: [],
  baseUrl: null,
  probing: false,
};

/** Keep only the latest probe, including when its connection changes or its screen closes. */
export function createModelProbe(onChange: (state: ModelProbeState) => void) {
  let revision = 0;
  return {
    invalidate() {
      revision += 1;
    },
    reset() {
      revision += 1;
      onChange(initialModelProbeState);
    },
    async probe(options: {
      baseUrl: string;
      apiKey: string;
      request: (input: { baseUrl: string; apiKey?: string }) => Promise<{ models: string[] }>;
      onSuccess: (models: string[]) => void;
      onError: (error: unknown) => void;
    }) {
      const baseUrl = options.baseUrl.trim();
      if (!baseUrl) return;
      const requestRevision = ++revision;
      onChange({ models: [], baseUrl: null, probing: true });
      try {
        const { models } = await options.request({
          baseUrl,
          apiKey: options.apiKey.trim() || undefined,
        });
        if (requestRevision !== revision) return;
        onChange({ models, baseUrl, probing: false });
        options.onSuccess(models);
      } catch (error) {
        if (requestRevision !== revision) return;
        onChange(initialModelProbeState);
        options.onError(error);
      }
    },
  };
}
