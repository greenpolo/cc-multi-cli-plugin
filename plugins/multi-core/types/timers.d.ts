// The hooks environment provides timers, which the generated engine declarations
// (`.claude/types/claude-code.d.ts`) do not list among its globals.
declare function setTimeout(callback: (...args: never[]) => void, ms?: number): number;
declare function clearTimeout(id: number | undefined): void;
