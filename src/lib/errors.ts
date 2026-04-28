/**
 * CLI exit codes. Match the conventions established by reference-implementation
 * banks (just-bash-data and similar) so users can dispatch on $? in scripts.
 */
export const EXIT = {
  OK: 0,
  RUNTIME: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  AUTH: 4,
  VALIDATION: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  override readonly name = "CliError";
  readonly exitCode: ExitCode;

  constructor(exitCode: ExitCode, message: string) {
    super(message);
    this.exitCode = exitCode;
  }
}

export const isCliError = (e: unknown): e is CliError => e instanceof CliError;
