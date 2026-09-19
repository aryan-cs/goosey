export type ThemePreference = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "goosey-theme";
export const THEME_CHANGE_EVENT = "goosey-theme-change";

export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function getThemePreference(): ThemePreference {
  return typeof document === "undefined" ? "system" : parseThemePreference(document.documentElement.getAttribute("data-theme"));
}

export function getServerThemePreference(): ThemePreference {
  return "system";
}

/** Switch immediately even when browser privacy settings prevent persistence. */
export function setThemePreference(preference: ThemePreference): boolean {
  const theme = parseThemePreference(preference);
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  let saved = true;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    saved = false;
  }
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  return saved;
}

export function subscribeToTheme(onChange: () => void): () => void {
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  return () => window.removeEventListener(THEME_CHANGE_EVENT, onChange);
}

// Runs synchronously in <head>, before first paint. The storage listener lives
// for the whole document, so other tabs update even pages without the switcher.
// Keep this self-contained: a server-generated script cannot import modules.
export const THEME_INIT_SCRIPT = `(function(){
var key=${JSON.stringify(THEME_STORAGE_KEY)},eventName=${JSON.stringify(THEME_CHANGE_EVENT)};
function apply(value){var root=document.documentElement;if(value==='light'||value==='dark'){root.setAttribute('data-theme',value)}else{root.removeAttribute('data-theme')}}
try{apply(window.localStorage.getItem(key))}catch(e){}
window.addEventListener('storage',function(event){
if(event.key!==key&&event.key!==null)return;
try{if(event.storageArea!==window.localStorage)return}catch(e){return}
apply(event.key===null?null:event.newValue);
window.dispatchEvent(new Event(eventName));
});
})();`;
