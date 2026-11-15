declare module "linkify-it" {
  interface LinkifyItInstance {
    set(options: { fuzzyLink?: boolean; fuzzyEmail?: boolean; fuzzyIP?: boolean }): this;
    add(schema: string, definition: null): this;
    match(
      text: string,
    ): Array<{ index: number; lastIndex: number; raw: string; url: string }> | null;
  }

  interface LinkifyItConstructor {
    new (): LinkifyItInstance;
  }

  const LinkifyIt: LinkifyItConstructor;
  export default LinkifyIt;
}
