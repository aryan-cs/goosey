import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getThemePreference, parseThemePreference, setThemePreference, subscribeToTheme, THEME_CHANGE_EVENT, THEME_INIT_SCRIPT, THEME_STORAGE_KEY } from "./theme";

function browser(stored: string | null = null) {
  const attributes = new Map<string, string>();
  const document = { documentElement: {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
  } };
  const localStorage = { getItem: vi.fn(() => stored), setItem: vi.fn() };
  const window = Object.assign(new EventTarget(), { localStorage });
  return { window, document, Event, attributes };
}

afterEach(() => vi.unstubAllGlobals());

describe("theme preferences", () => {
  it("uses system for unset or invalid stored values", () => {
    for (const value of [null, undefined, "system", "sepia", "DARK", {}]) expect(parseThemePreference(value)).toBe("system");
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
  });

  it("applies a saved explicit preference during the pre-paint script", () => {
    for (const theme of ["light", "dark"]) {
      const context = browser(theme);
      runInNewContext(THEME_INIT_SCRIPT, context);
      expect(context.attributes.get("data-theme")).toBe(theme);
      expect(context.window.localStorage.getItem).toHaveBeenCalledWith(THEME_STORAGE_KEY);
    }
  });

  it("lets CSS follow the OS in system mode and tolerates blocked storage", () => {
    const context = browser("system");
    context.attributes.set("data-theme", "dark");
    runInNewContext(THEME_INIT_SCRIPT, context);
    expect(context.attributes.has("data-theme")).toBe(false);
    const blocked = browser();
    Object.defineProperty(blocked.window, "localStorage", { get() { throw new Error("Storage blocked"); } });
    expect(() => runInNewContext(THEME_INIT_SCRIPT, blocked)).not.toThrow();
    expect(blocked.attributes.has("data-theme")).toBe(false);
  });

  it("switches immediately and notifies controls even if persistence fails", () => {
    const context = browser();
    vi.stubGlobal("window", context.window);
    vi.stubGlobal("document", context.document);
    context.window.localStorage.setItem.mockImplementation(() => { throw new Error("Quota exceeded"); });
    const changed = vi.fn();
    const unsubscribe = subscribeToTheme(changed);
    expect(setThemePreference("dark")).toBe(false);
    expect(getThemePreference()).toBe("dark");
    expect(changed).toHaveBeenCalledOnce();
    expect(setThemePreference("system")).toBe(false);
    expect(context.attributes.has("data-theme")).toBe(false);
    unsubscribe();
    setThemePreference("light");
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("persists each choice including an explicit system preference", () => {
    const context = browser();
    vi.stubGlobal("window", context.window);
    vi.stubGlobal("document", context.document);
    for (const preference of ["dark", "light", "system"] as const) {
      expect(setThemePreference(preference)).toBe(true);
      expect(context.window.localStorage.setItem).toHaveBeenLastCalledWith(THEME_STORAGE_KEY, preference);
      expect(getThemePreference()).toBe(preference);
    }
  });

  it("syncs another tab's changes and clear while ignoring unrelated storage", () => {
    const context = browser("light");
    runInNewContext(THEME_INIT_SCRIPT, context);
    const changed = vi.fn();
    context.window.addEventListener(THEME_CHANGE_EVENT, changed);
    function storage(key: string | null, newValue: string | null, storageArea: object = context.window.localStorage) {
      const event = Object.assign(new Event("storage"), { key, newValue, storageArea });
      context.window.dispatchEvent(event);
    }
    storage("unrelated", "dark");
    storage(THEME_STORAGE_KEY, "dark", {});
    expect(context.attributes.get("data-theme")).toBe("light");
    expect(changed).not.toHaveBeenCalled();
    storage(THEME_STORAGE_KEY, "dark");
    expect(context.attributes.get("data-theme")).toBe("dark");
    storage(null, null);
    expect(context.attributes.has("data-theme")).toBe(false);
    storage(THEME_STORAGE_KEY, "invalid");
    expect(context.attributes.has("data-theme")).toBe(false);
    expect(changed).toHaveBeenCalledTimes(3);
  });
});
