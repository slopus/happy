import { createContext, useContext } from "react";
export const PawsPortalContext = createContext<HTMLElement | undefined>(undefined);
export function usePawsPortal() { return useContext(PawsPortalContext); }
