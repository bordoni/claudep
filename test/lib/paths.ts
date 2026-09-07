/**
 * Path spellings the assertions need on every platform.
 */
import { sep } from "node:path";

/** Comparison key for a readlink result: identity on POSIX; on Windows no
 *  \\?\ prefix, backslashes, lower case. Mirrors pathKey() in claudep.ts. */
export function norm(p: string): string {
  if (process.platform !== "win32") return p;
  const bare = p.startsWith("\\\\?\\") ? p.slice(4) : p;
  return bare.replace(/\//g, "\\").toLowerCase();
}

/** `~` followed by the segments joined with the native separator. */
export function tilde(...segs: string[]): string {
  return ["~", ...segs].join(sep);
}

/** Escape a literal for use inside a RegExp. */
export function rx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The MSYS spelling of a native Windows path: C:\a\b -> /c/a/b. Identity elsewhere. */
export function msys(p: string): string {
  if (process.platform !== "win32") return p;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p.replace(/\\/g, "/");
  return `/${(m[1] as string).toLowerCase()}/${(m[2] as string).replace(/\\/g, "/")}`;
}
