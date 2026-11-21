export interface MachineFacts {
  readonly platform?: string;
  readonly hostname?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isWsl?: boolean;
}

export function machineIdFor(facts?: MachineFacts): string;
