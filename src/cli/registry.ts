export type CommandHandler = (argv: string[]) => unknown | Promise<unknown>;
export type CommandRegistry = Readonly<Record<string, CommandHandler>>;

export async function dispatchRegisteredCommand(
  command: string,
  argv: string[],
  registry: CommandRegistry,
): Promise<boolean> {
  const handler = Object.prototype.hasOwnProperty.call(registry, command)
    ? registry[command]
    : undefined;
  if (!handler) return false;
  await handler(argv);
  return true;
}
