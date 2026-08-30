/** Per-process Git configuration; never persisted in a repository or user config. */
export function gitArguments(args: string[], platform: string = process.platform): string[] {
  return platform === "win32" ? ["-c", "core.longpaths=true", ...args] : args;
}

/** Git clears command config at transport boundaries. Configure only a declared local child. */
export function gitTransportArguments(operation: "clone" | "fetch" | "ls-remote" | "push", locator: string, platform: string = process.platform): string[] {
  if (platform !== "win32" || !/^(?:file:\/\/|[/\\]|[A-Za-z]:[/\\])/.test(locator)) return [];
  const pack = operation === "push" ? "receive-pack" : "upload-pack";
  return [`--${pack}=git -c core.longpaths=true ${pack}`];
}
