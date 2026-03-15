import { useState, useEffect, useRef } from 'react';
import { getTauriAPI } from '../services/tauri';
import { capabilities } from '../platform/capabilities';

interface LogViewerProps {
    isOpen: boolean;
    onClose: () => void;
}

export default function LogViewer({ isOpen, onClose }: LogViewerProps) {
    const [logs, setLogs] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const logsEndRef = useRef<HTMLDivElement>(null);

    const loadLogs = async () => {
        if (!capabilities.hasNativeLogs) return;
        setLoading(true);
        try {
            const api = await getTauriAPI();
            if (api) {
                const logData = await api.invoke<string[]>('get_logs');
                setLogs(logData);
            }
        } catch (err) {
            console.error('Failed to load logs:', err);
        }
        setLoading(false);
    };

    useEffect(() => {
        if (isOpen) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            loadLogs();
            const interval = setInterval(loadLogs, 2000);
            return () => clearInterval(interval);
        }
    }, [isOpen]);

    useEffect(() => {
        logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [logs]);

    const clearLogs = async () => {
        if (!capabilities.hasNativeLogs) return;
        try {
            const api = await getTauriAPI();
            if (api) {
                await api.invoke('clear_logs');
                setLogs([]);
            }
        } catch (err) {
            console.error('Failed to clear logs:', err);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
            <div className="w-[800px] max-h-[80vh] bg-zinc-900 border border-zinc-700 rounded-lg flex flex-col">
                <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
                    <div className="flex items-center gap-3">
                        <h2 className="text-lg font-semibold text-white">Logs</h2>
                        <span className="text-xs text-zinc-500">
                            {logs.length} entries {loading && '(updating...)'}
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={loadLogs}
                            className="px-3 py-1 text-xs text-zinc-400 hover:text-white hover:bg-zinc-800 rounded transition-colors"
                        >
                            Refresh
                        </button>
                        <button
                            onClick={clearLogs}
                            className="px-3 py-1 text-xs text-zinc-400 hover:text-white hover:bg-zinc-800 rounded transition-colors"
                        >
                            Clear
                        </button>
                        <button
                            onClick={onClose}
                            className="p-1 text-zinc-400 hover:text-white transition-colors"
                        >
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                </div>
                <div className="flex-1 overflow-auto p-4 font-mono text-xs">
                    {logs.length === 0 ? (
                        <div className="text-zinc-500 text-center py-8">No logs yet</div>
                    ) : (
                        logs.map((log, idx) => (
                            <div key={idx} className={`py-0.5 ${log.includes('ERROR') ? 'text-red-400' : log.includes('WARN') ? 'text-amber-400' : 'text-zinc-300'}`}>
                                {log}
                            </div>
                        ))
                    )}
                    <div ref={logsEndRef} />
                </div>
                <div className="px-4 py-2 border-t border-zinc-700 text-xs text-zinc-500">
                    Press L or ESC to close
                </div>
            </div>
        </div>
    );
}
