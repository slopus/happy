// Each opaque frame has disposable storage. Install before any vendor script executes.
(() => {
  const storage = () => {
    const values = new Map();
    return {
      getItem: (key) => values.get(String(key)) ?? null,
      setItem: (key, value) => {
        values.set(String(key), String(value));
      },
      removeItem: (key) => {
        values.delete(String(key));
      },
      clear: () => {
        values.clear();
      },
      key: (index) => [...values.keys()][Number(index) >>> 0] ?? null,
      get length() {
        return values.size;
      },
    };
  };
  for (const name of ["localStorage", "sessionStorage"]) {
    Object.defineProperty(window, name, { value: storage(), configurable: true });
  }
  Object.defineProperty(document, "cookie", {
    get: () => "",
    set: () => {},
    configurable: true,
  });
})();
