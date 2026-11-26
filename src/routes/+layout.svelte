<script lang="ts">
    import "./layout.css";
    import { info, debug, error, warn, trace } from "@tauri-apps/plugin-log";

    if (import.meta.env.DEV) {
        const formatArgs = (args: unknown[]) =>
            args
                .map((arg) => {
                    if (arg !== null && typeof arg === "object") {
                        try {
                            return JSON.stringify(arg, null, 2);
                        } catch {
                            return "[Circular Object]";
                        }
                    }
                    return String(arg);
                })
                .join(" ");

        function attachConsole(
            fnName: "log" | "info" | "debug" | "error" | "warn" | "trace",
            logger: (message: string) => Promise<void>,
        ) {
            const original = console[fnName].bind(console);
            console[fnName] = (...args: unknown[]) => {
                original(...args);
                logger(formatArgs(args)).catch(() => {});
            };
        }

        attachConsole("log", info);
        attachConsole("info", info);
        attachConsole("debug", debug);
        attachConsole("warn", warn);
        attachConsole("error", error);
        attachConsole("trace", trace);
    }

    const { children } = $props();
</script>

{@render children()}
