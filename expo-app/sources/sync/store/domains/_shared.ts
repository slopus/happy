export type StoreSet<S> = {
  (partial: S | Partial<S> | ((state: S) => S | Partial<S>), replace?: false): void;
  (state: S | ((state: S) => S), replace: true): void;
};

export type StoreGet<S> = () => S;
