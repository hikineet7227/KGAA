<script lang="ts">
    import "./layout.css";

    if (import.meta.env.DEV) {
        function logConsole(
            fnName: "info" | "debug" | "error" | "warn" | "trace",
            logger: (messagge: string) => Promise<void>,
        ) {
            const original = console[fnName];
            console[fnName] = (...args: unknown[]) => {
                const message = args
                    .map((arg) =>
                        typeof arg === "object"
                            ? JSON.stringify(args, null, 2)
                            : String(arg),
                    )
                    .join(" ");

                logger(message);
            };
        }
    }

    const { children } = $props();
</script>

{@render children()}
