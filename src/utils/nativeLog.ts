import { isTauri, getTauriAPI } from '../services/tauri';

// Mirror frontend diagnostics into the native log ring buffer (L key) so field
// reports from installed builds include the frontend's view of what happened.
export function logNative(message: string) {
    if (!isTauri()) return;
    getTauriAPI()
        .then(api => api?.invoke('log_event', { message }))
        .catch(() => {});
}
