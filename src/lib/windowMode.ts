export type WindowMode = "normal" | "verify" | "whatif" | "cfg";

export function getWindowMode(): { mode: WindowMode; readonly: boolean } {
  const sp = new URLSearchParams(window.location.search);
  // VSCode 模式下无 URL 参数，从注入的 __optrace_init__ 读取
  const init = (window as unknown as Record<string, unknown>).__optrace_init__ as Record<string, unknown> | undefined;
  const modeRaw = (sp.get("mode") || String(init?.mode ?? "")).toLowerCase();
  const readonlyRaw = (sp.get("readonly") || String(init?.readonly ?? "")).toLowerCase();

  const mode: WindowMode =
    modeRaw === "verify" ? "verify" :
    modeRaw === "whatif" ? "whatif" :
    modeRaw === "cfg" ? "cfg" :
    "normal";
  // canonical switch is `readonly`; keep `mode=verify` for backward compatibility
  const readonly = readonlyRaw === "1" || readonlyRaw === "true" || mode === "verify";
  return { mode, readonly };
}

