// Sucrase ships its parser's types beside the build rather than at the build's path.
declare module "sucrase/dist/parser/index.js" {
  export { parse } from "sucrase/dist/types/parser/index.js";
}

declare module "sucrase/dist/parser/tokenizer/index.js" {
  export { IdentifierRole } from "sucrase/dist/types/parser/tokenizer/index.js";
}

declare module "sucrase/dist/parser/tokenizer/types.js" {
  export { TokenType } from "sucrase/dist/types/parser/tokenizer/types.js";
}
