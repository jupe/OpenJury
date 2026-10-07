"use client";

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";

export type Theme = "white" | "dark" | "auto";

const STORAGE_KEY = "openjury:theme";
const themeListeners = new Set<() => void>();
let currentTheme: Theme | null = null;

function getThemeSnapshot(): Theme {
  if (currentTheme !== null) return currentTheme;
  try {
    const savedTheme = window.localStorage.getItem(STORAGE_KEY);
    if (savedTheme === "white" || savedTheme === "dark" || savedTheme === "auto") return savedTheme;
  } catch {
    return "auto";
  }
  return "auto";
}

function getServerThemeSnapshot(): Theme {
  return "auto";
}

function applyTheme(theme: Theme) {
  const isDark = theme === "dark" || (
    theme === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches
  );
  document.documentElement.dataset.theme = isDark ? "dark" : "white";
  document.documentElement.style.colorScheme = isDark ? "dark" : "light";
}

function subscribeToTheme(listener: () => void) {
  themeListeners.add(listener);
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    try {
      const savedTheme = window.localStorage.getItem(STORAGE_KEY);
      currentTheme = savedTheme === "white" || savedTheme === "dark" || savedTheme === "auto"
        ? savedTheme
        : "auto";
    } catch {
      currentTheme = "auto";
    }
    applyTheme(currentTheme);
    listener();
  };
  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const handleSystemThemeChange = () => {
    if (getThemeSnapshot() === "auto") {
      applyTheme("auto");
      listener();
    }
  };
  window.addEventListener("storage", handleStorage);
  mediaQuery.addEventListener("change", handleSystemThemeChange);

  return () => {
    themeListeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
    mediaQuery.removeEventListener("change", handleSystemThemeChange);
  };
}

function updateTheme(theme: Theme) {
  currentTheme = theme;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Theme preference remains available for this session.
  }
  applyTheme(theme);
  themeListeners.forEach((listener) => listener());
}

type ThemeContextValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(subscribeToTheme, getThemeSnapshot, getServerThemeSnapshot);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const value = useMemo(() => ({ theme, setTheme: updateTheme }), [theme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("ThemeProvider is required.");
  return context;
}
