"use client";

import { createContext, useContext, useMemo } from "react";

const PublicContentContext = createContext({ discordBanner: null });

export function PublicContentProvider({ discordBanner = null, children }) {
  const value = useMemo(() => ({ discordBanner }), [discordBanner]);
  return <PublicContentContext.Provider value={value}>{children}</PublicContentContext.Provider>;
}

export const usePublicContent = () => useContext(PublicContentContext);
