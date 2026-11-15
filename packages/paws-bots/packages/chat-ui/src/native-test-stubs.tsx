import { createElement } from "react";

/**
 * Vite-resolution stubs for native-only transitive dependencies of the markdown
 * renderer (fit-image, vector icons). They let node tests load the renderer's
 * shipped TypeScript source without a Metro/Babel pipeline.
 */
const StubComponent = () => createElement("rn-stub");

export const MaterialDesignIcons = StubComponent;
export default StubComponent;
