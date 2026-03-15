/**
 * Detects if the app is running within the Tauri environment.
 */
export function isTauri(): boolean {
    return !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ || !!(window as unknown as { __TAURI__?: unknown }).__TAURI__;
}

/**
 * Dynamics imports for Tauri APIs to avoid errors in the browser.
 */
export async function getTauriAPI() {
    if (!isTauri()) return null;
    
    // Using dynamic imports for Tauri v2
    const { invoke } = await import('@tauri-apps/api/core');
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { readDir, readFile, BaseDirectory, stat } = await import('@tauri-apps/plugin-fs');
    
    return {
        invoke,
        open,
        readDir,
        readFile,
        BaseDirectory,
        stat
    };
}
